const { performance } = require('perf_hooks'),
    express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    WebSocket = require('ws'),
    { nanoid } = require('nanoid'),
    moment = require('moment'),
    axios = require('axios').default,
    port = 4000;

app.get('/', (req, res) => res.send('Nothing to do here.'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models'),
    { Op, QueryTypes } = db.Sequelize,
    { conversation, message } = require('./models');

const wss = new WebSocket.Server({server: server});

const minInterval = 800,
    maxPenaltyPoints = 10000,
    systemQueries = ['recaptcha_chill', 'auth', 'relation', 'readMessage', 'figureBoard'];

let USERS = {},
    SOCKETS = {},
    SUSS = {},
    BOARDS = {};

class Board {
    constructor(id) {
        this.id = id;
        this.owner_id = id;
        this.members = [];
        this.newMember(this.owner_id);
    }
    newMember(user_id) {
        this.members.push({
            id: user_id,
            paths: []
        });
    }
}
class Police {
    constructor(id) {
        this.id = id;
        this.penaltyPoints = 0;
        this.lastEmit = Date.now();
    }
    inspect() {
        let thisMoment = Date.now(),
            interval = thisMoment - this.lastEmit,
            fine = minInterval-interval < 0 ? 0 : minInterval-interval,
            pass = 0;
        console.log(`Штрафные очки: ${this.penaltyPoints}+${fine}/${maxPenaltyPoints}`);
        this.penaltyPoints += fine;
        this.lastEmit = Date.now();
        if (this.penaltyPoints >= maxPenaltyPoints) {
            // ReCAPTCHA
            pass = -1;
        }
        if (this.penaltyPoints >= maxPenaltyPoints*2) {
            // BAN
            pass = -2;
        }
        return pass;
    }
}
db.sequelize.sync({alter: true}).then(async (req) => {
    console.log('Sequalize started successfully.');
});
wss.on('connection', function(ws) {
    let uid = -1;
    ws.on('message', async function(data) {
        let pack = JSON.parse(data),
            response = null;
        // POLICE CHECK: Hey, first of all the police check \\
        if (pack.query != 'auth' && pack.query != 'recaptcha_chill' && uid != -1 && (systemQueries.findIndex(e => e == pack.query) == -1)) {
            
            let pass = SUSS[uid].inspect();
            if (pass == -1) emit(ws, 'recaptcha');
            if (pass == -2) {
                emit(ws, 'recaptcha');
                return withResponse(ws, pack.query, 'suspicious');
            }
        }
        // POLICE CHECK: Okay sir, зря быканул \\

        let before = performance.now();
        if (pack.query != 'auth' && uid == -1) return withResponse(ws, pack.query, pack.query+'is declined. No authorization.');
        switch(pack.query) {
            case 'recaptcha_chill': {
                let secret_key = '6LdIXGsaAAAAAIv8viof2Ja0SEKMXxBqbh62itoH',
                    token = pack.token,
                    url = `https://www.google.com/recaptcha/api/siteverify?secret=${secret_key}&response=${token}`;

                axios.post(url).then((response) => {
                    if (response.data.success) {
                        SUSS[uid].penaltyPoints = 0;
                    }
                });
            } break;
            case 'logout': {
                ws.terminate();
            } break;
            case 'auth': {
                // pack.login, pack.password
                try {
                    if (USERS[pack.id] != undefined) return withResponse(ws, pack.query, 'alreadysignedin');
                    let newUser = await selectUser('login', pack.login);
                    if (newUser.password != pack.password) return withResponse(ws, pack.query, 'Wrong user login or password.');
                    // uid is global val for 'connection'
                    uid = newUser.id;
                    ws.uid = uid;
                    // Store temporarily while online in USERS all user data
                    USERS[uid] = newUser;
                    // Store temporarily while online socket data
                    SOCKETS[uid] = ws;
                    // Store until server restarts Police data
                    if (SUSS[uid] === undefined) SUSS[uid] = new Police(uid);
                    console.log(USERS[uid].login+' entered the site.');
                    emit(ws, 'online');
                } catch (e) {
                    // Login is wrong (normally its impossible, because client sends after auth)
                    ws.terminate();
                }
            } break;
            case 'relation': {
                let user = USERS[uid],
                    user_b = USERS[pack.user_b];
                if (user_b === undefined) return withResponse(ws, pack.query, 'Offline.'); // If he is offline

                let relationStatus = pack.relationStatus,
                    message;
                switch(relationStatus) {
                    case '-2': message = user.login+' удалил Вас из друзей.'; break;
                    case '-1': message = user.login+' отклонил заявку в друзья.'; break;
                    case '0': message = user.login+' хочет добавить Вас в друзья.'; break;
                    case '2': message = user.login+' принял Вашу заявку в друзья.'; break;
                    default: break;
                }
                emit(SOCKETS[user_b.id], 'announce', {type: 'I', message});
            } break;
            case 'getUsers': {
                let collectedList = [];
                packLoop:
                for(i in pack.list) {
                    for(j in USERS) {
                        if (pack.list[i] == USERS[j].id) {
                            collectedList.push(pack.list[i]);
                            continue packLoop;
                        }
                    }
                }
                response = collectedList;
            } break;
            // Conversations
            case 'newConversation': {
                let user = USERS[uid],
                    owner_id = user.id,
                    name = pack.name,
                    participants = pack.participants,
                    password = nanoid();

                if (name.length < 1 || name.length > 144) return withResponse(ws, pack.query, 'Too long name.');
                if (participants.length == 0) return withResponse(ws, pack.query, 'No participants.');

                participants.push(owner_id);
                let members = [];
                for(i in participants) {
                    let rights = participants[i] == owner_id ? 1 : 0; // If it's owner then rights = 1
                    members.push({id: participants[i], rights, enteredDate: moment()});
                }
                let newConv = await conversation.create({
                    owner_id,
                    name,
                    password,
                    participants: JSON.stringify(members)
                });
                for(i in participants) {
                    let p = await selectUser('id', participants[i]); // p -> participant
                    if (p.conversations == null) p.conversations = [];

                    let pc = p.conversations;
                    pc.push({id: newConv.id, password, messagesRead: 0});
                    let pcJson = JSON.stringify(pc);

                    if (USERS[participants[i]] != undefined) { // If this user is actually online, then just update the new value
                        USERS[participants[i]].conversations = pc;
                        // Sync online user with new conversation
                        emit(SOCKETS[participants[i]], 'newConversation', {name});
                    }

                    const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                }
                response = newConv;
            } break;
            case 'editConversation': {
                let action = pack.action,
                    data = pack.data,
                    conv_id = pack.conv_id;
                let conv = await conversation.findOne({
                    where: {
                        id: conv_id
                    }
                });                
                switch(action) {
                    case 'add': {
                        let addIds = data.addIds,
                            participants = JSON.parse(conv.participants),
                            haveRights = false,
                            exists = false;
                        checkIfHasRights:
                        for(i in participants) {
                            if (participants[i].id == uid && participants[i].rights == 1) {
                                haveRights = true;
                                break checkIfHasRights;
                            }
                        }

                        if (!haveRights) return withResponse(ws, pack.query, 'У вас нет прав.');

                        let addMembers = [];
                        for(i in addIds) {
                            if (addIds[i] == uid) continue;
                            participants.push({id: addIds[i], rights: 0, enteredDate: moment()});

                            let p = await selectUser('id', addIds[i]); // p -> participant
                            addMembers.push({id: p.id, login: p.login, fullname: p.fullname});
                            if (p.conversations == null) p.conversations = [];
                            let pc = p.conversations;
                            pc.push({id: conv.id, password: conv.password, messagesRead: 0});
                            let pcJson = JSON.stringify(pc);
                            const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                            newMessage(conv_id, -1, `${USERS[uid].login} добавил ${p.login} в беседу.`);
                        }
                        conv.participants = JSON.stringify(participants);
                        await conv.save();
                        
                        for(i in participants) {
                            let op = participants[i];
                            if (USERS[op.id] != undefined) { // If this user is actually online, then just update the new value
                                // Sync online user with new conversation
                                for(j in addMembers) {
                                    emit(SOCKETS[op.id], 'addedConversation', {addId: addMembers[j].id, conv_id: conv.id, name: conv.name, addLogin: addMembers[j].login, addFullname: addMembers[j].fullname});
                                }
                            }
                        }
                        response = 'added';
                    } break;
                    case 'kick': {
                        let kickId = data.kickId,
                            participants = JSON.parse(conv.participants),
                            haveRights = false,
                            exists = false;
                        checkIfHasRights:
                        for(i in participants) {
                            if (participants[i].id == uid && participants[i].rights == 1) {
                                haveRights = true;
                                break checkIfHasRights;
                            }
                        }
                        if (kickId == uid) haveRights = true; // Kick myself = leave
                        if (!haveRights) return withResponse(ws, pack.query, 'У вас нет прав.');
                        removeProcess:
                        for(i in participants) {
                            if (participants[i].id == kickId) {
                                participants.splice(i, 1);
                                break removeProcess;
                            }
                        }
                        let isThereAnyAdmin = participants.findIndex(e => e.rights == 1) != -1;
                        if (!isThereAnyAdmin) console.log('No admins left in '+conv.name);

                        conv.participants = JSON.stringify(participants);
                        await conv.save();

                        let p = await selectUser('id', kickId); // p -> participant
                        if (p.conversations == null) p.conversations = [];
                        let pc = p.conversations;

                        removeFromUsersTable:
                        for(i in pc) {
                            if (pc[i].id == conv_id) {
                                pc.splice(i, 1);
                                break removeFromUsersTable;
                            }
                        }
                        let pcJson = JSON.stringify(pc);
                        
                        const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                        
                        participants.unshift({id: kickId});
                        for(i in participants) {
                            let op = participants[i];
                            if (USERS[op.id] != undefined) { // If this user is actually online, then just update the new value
                                // Sync online user with deleted conversation
                                emit(SOCKETS[op.id], 'deletedConversation', {kickId, conv_id: conv.id, name: conv.name, isLeave: kickId == uid});
                            }
                        }
                        if (kickId == uid) {
                            newMessage(conv_id, -1, `${p.login} покинул беседу.`);
                        }
                        else {
                            newMessage(conv_id, -1, `${USERS[uid].login} исключил ${p.login} из беседы.`);
                        }
                        response = 'kicked';
                    } break;
                }
            } break;
            case 'getMyConversations': {
                await updateMe(USERS[uid]); // Sync user data with real data
                let user = USERS[uid],
                    conds = [],
                    pc = user.conversations;
                for(i in pc) {
                    conds.push({id: pc[i].id, password: pc[i].password});
                }
                response = {};
                response.myConversations = pc;
                response.conversationsList = await conversation.findAll({
                    where: {
                        [Op.or]: conds
                    },
                    order: [
                        ['updatedAt', 'DESC']
                    ]
                });
            } break;
            case 'newMessage': {
                // pack.conv_id, pack.text
                let conv_id = pack.conv_id,
                    owner_id = uid,
                    text = pack.text,
                    hash = pack.hash;
                newMessage(conv_id, owner_id, text, hash, ws);
            } break;
            case 'readMessage': {
                let conv_id = pack.conv_id,
                    messagesRead = pack.messagesRead;
                
                await updateMe(USERS[uid]); // Sync user data with real data
                let user = USERS[uid],
                    pc = user.conversations;
                for(i in pc) {
                    if (pc[i].id == conv_id) {
                        pc[i].messagesRead = messagesRead;
                        let pcJson = JSON.stringify(pc);
                        const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, user.id]});
                        break;
                    }
                }
            } break;
            case 'getMessages': {
                // pack.conv_id
                let conv_id = pack.conv_id;
                response = await message.findAll({
                    where: {
                        conv_id
                    },
                    order: [
                        ['createdAt', 'DESC']
                    ],
                    limit: 200
                });
            } break;
            case 'newBoard': {
                BOARDS[uid] = new Board(uid);
                response = BOARDS[uid];
            } break;
            case 'inviteBoard': {
                let list = pack.list,
                    board = BOARDS[uid],
                    newMembers = [];
                for(i in list) {
                    if (board.members.findIndex(e => e.id == list[i]) == -1) {
                        if (USERS[list[i]] != undefined) {
                            board.newMember(list[i]);
                            newMembers.push(list[i]);
                        }
                    }
                }
                for(i in newMembers) {
                    emit(SOCKETS[newMembers[i]], 'newBoard', {board});
                }
                for(i in board.members) {
                    if (newMembers.findIndex(e => e == board.members[i].id) != -1) continue;
                    if (USERS[board.members[i].id] != undefined) {
                        emit(SOCKETS[board.members[i].id], 'newBoardMember', {newMembers});
                    }
                }
                response = board;
            } break;
            case 'figureBoard': {
                let board_id = pack.board_id,
                    x = pack.x,
                    y = pack.y,
                    beginPath = pack.beginPath;

                for(i in BOARDS[board_id].members) {
                    if (BOARDS[board_id].members[i].id == uid) {
                        if (beginPath != undefined) {
                            BOARDS[board_id].members[i].paths.push({x: -1});
                        }
                        else {
                            BOARDS[board_id].members[i].paths.push({x, y});
                        }
                    }
                }
                for(i in BOARDS[board_id].members) {
                    let member = BOARDS[board_id].members[i];
                    if (USERS[member.id] != undefined) {
                        emit(SOCKETS[member.id], 'figureBoard', {member_id: uid, x, y});
                    }
                }
            } break;
        }
        emit(ws, '&'+pack.query, {response});
        let after = performance.now();
        console.log(USERS[uid].login+' made a query. Served in '+(after-before).toFixed(2)+' ms.')
    });
    ws.on('close', function(close) {
        delete USERS[uid];
        delete SOCKETS[uid];
    });
    ws.on('pong', function() {
        if (USERS[uid] === undefined) return;
        ws.pingAfter = performance.now();
        ws.pingValue = (ws.pingAfter - ws.pingBefore).toFixed(1);
        emit(ws, 'pingValue', {ping: ws.pingValue});
    });
});
async function newMessage(conv_id, owner_id, text, hash, ws) {
    let haveRights = false;
    if (ws === undefined) haveRights = true;
    if (hash === undefined) hash = 'system';
    // Increment conversation's totalMessages
    let conv = await conversation.findOne({
        where: {
            id: conv_id
        }
    }),
    participants = JSON.parse(conv.participants);

    checkIfHaveRights:
    for (i in participants) {
        if (participants[i].id == owner_id) {
            haveRights = true;
            break checkIfHaveRights;
        } 
    }
    if (!haveRights) return withResponse(ws, 'newMessage', 'У вас нет прав.');

    conv.totalMessages = conv.totalMessages+1;

    response = await message.create({
        conv_id,
        owner_id,
        text
    });
    for(i in USERS) {
        let iu = USERS[i],
            convs = iu.conversations;

        if (convs.findIndex(e => e.id == conv_id) != -1) {
            emit(SOCKETS[iu.id], 'updateConversation', {newMessage: response, hash});
        }
    }
    await conv.save();
}
function withResponse(ws, query, response) {
    if (response === undefined) response = 'Unknown error.';
    emit(ws, '&'+query, {type: 'error', response});
}
async function updateMe(user) {
    return new Promise((resolve, reject) => {
        db.sequelize.query(`SELECT * FROM users WHERE id = ? and password = ? LIMIT 1`, { type: QueryTypes.SELECT, replacements: [user.id, user.password] }).then((query) => {
            // If found someone
            if (query.length > 0) {
                let user_newData = query[0];
                USERS[user.id] = user_newData;
                
                if (typeof USERS[user.id].conversations == 'string') {
                    USERS[user.id].conversations = JSON.parse(USERS[user.id].conversations);
                }
                resolve();
            }
            else {
                reject();
            }
        });
    });
}
async function selectUser(type, login) {
    return new Promise((resolve, reject) => {
        db.sequelize.query(`SELECT * FROM users WHERE ${type} = ? LIMIT 1`, { type: QueryTypes.SELECT, replacements: [login] }).then((query) => {
            // If found someone
            if (query.length > 0) {
                let user = query[0];
                user.conversations = JSON.parse(user.conversations);
                resolve(user);
            }
            else {
                reject();
            }
        });
    });
}
function emit(ws, query, data) {
    let pack = {query};
    for(let i in data) {
        pack[i] = data[i];
    }
    ws.send(JSON.stringify(pack));
}

// Ping check
const globalEachSecond = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.uid === undefined) return;
        ws.ping();
        ws.pingBefore = performance.now();
    });
}, 2000);