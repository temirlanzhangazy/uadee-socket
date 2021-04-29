const { performance } = require('perf_hooks'),
    express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    WebSocket = require('ws'),
    { nanoid } = require('nanoid'),
    moment = require('moment'),
    osu = require('node-os-utils'),
    axios = require('axios').default,
    port = 4000,
    { Chess } = require('chess.js');

require('path');
require('./scripts/randomcolor');

app.get('/', (req, res) => res.send('Nothing to do here.'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models'),
    { Op, QueryTypes } = db.Sequelize,
    { conversation, message } = require('./models');

const wss = new WebSocket.Server({server: server});

const minInterval = 800,
    maxPenaltyPoints = 10000,
    systemQueries = ['recaptcha_chill', 'auth', 'relation', 'readMessage', 'chess']; // Chess <- косяк

const USERS = {},
    SOCKETS = {},
    STOCK = {},
    CALLROOMS = {};

let VOLS = [],
    PENS = [];

let CHESSMATCHES = [];
class ChessMatch {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.chess = new Chess();
    }
    board() {
        return this.chess.board();
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
class CallRoom {
    constructor(id) {
        this.id = id;
        this.members = [];
        this.ringingList = [];
    }
    newMember(id, login, peerid) {
        if (this.members.findIndex(e => e.id == id) != -1) return;
        let newMemberData = {id, login, peerid};
        this.members.forEach(e => {
            if (!SOCKETS[e.id]) return;
            emit(SOCKETS[e.id], 'videocall_newMember', newMemberData);
        });
        this.members.push(newMemberData);

        if (USERS[id] != undefined) {
            SOCKETS[id].callroom = this.id;
        }
        this.deleteRinglist(id);
        console.log(this.ringingList);
    }
    deleteMember(id) {
        let ind = this.members.findIndex(e => e.id == id);
        if (ind == -1) return;
        this.members.splice(ind, 1);
        this.members.forEach(e => {
            if (!SOCKETS[e.id]) return;
            emit(SOCKETS[e.id], 'videocall_leftMember', {id});
        });

        // If room is empty now
        if (this.members.length == 0) {
            this.ringingList.forEach(e => {
                if (!SOCKETS[e.id]) return;
                emit(SOCKETS[e.id], 'videocall_stopRingtone', {roomid: this.id});
            });
            delete CALLROOMS[this.id];
        }
    }
    deleteRinglist(id) {
        let ind = this.ringingList.findIndex(e => e.id == id);
        if (ind != -1) {
            this.ringingList.splice(ind, 1);
        }
    }
}
class Pen {
    constructor(id) {
        this.id = id;
        this.members = [];
    }
    newMember(id, login, peerid) {
        if (this.members.findIndex(e => e.id == id) != -1) return;
        let newMemberData = {id, login, peerid};

        this.members.forEach(e => {
            if (!SOCKETS[e.id]) return;
            emit(SOCKETS[e.id], 'pen_newMember', newMemberData);
        });
        this.members.push(newMemberData);

        if (USERS[id] != undefined) {
            SOCKETS[id].spacepen = this.id;
        }
    }
}
db.sequelize.sync({alter: true}).then(async () => {
    console.log('Sequalize started successfully.');
});
wss.on('connection', function(ws) {
    let uid = -1;
    ws.on('message', async function(data) {
        let pack = JSON.parse(data),
            response = null;
        // POLICE CHECK: Hey, first of all the police check \\
        if (pack.query != 'auth' && pack.query != 'recaptcha_chill' && uid != -1 && (systemQueries.findIndex(e => e == pack.query) == -1)) {
            let pass = STOCK[uid]?.police?.inspect();
            switch (pass) {
                case -1: emit(ws, 'recaptcha'); break;
                case -2: emit(ws, 'recaptcha'); return withResponse(ws, pack.query, 'suspicious');
                case undefined: return withResponse(ws, pack.query, 'No STOCK inspection.');
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
                        STOCK[uid].police.penaltyPoints = 0;
                    }
                });
            } break;
            case 'logout': {
                ws.terminate();
            } break;
            case 'auth': {
                // pack.login, pack.password
                try {
                    //if (USERS[pack.id] != undefined) return withResponse(ws, pack.query, 'alreadysignedin');
                    let newUser = await selectUser('login', pack.login);
                    if (newUser.password != pack.password) return withResponse(ws, pack.query, 'Wrong user login or password.');
                    // uid is global val for 'connection'
                    uid = newUser.id;
                    ws.uid = uid;
                    // Store temporarily while online in USERS all user data
                    USERS[uid] = newUser;
                    // Store temporarily while online socket data
                    if (SOCKETS[uid] === undefined) SOCKETS[uid] = [];
                    SOCKETS[uid].push(ws);
                    // Store until server restarts Police data
                    if (STOCK[uid] === undefined) {
                        STOCK[uid] = {
                            police: new Police(uid)
                        };
                    }
                    console.log(USERS[uid].login+' entered the site.');
                    emit(ws, 'online');
                } catch (e) {
                    // Login is wrong (normally its impossible, because client sends after auth)
                    return withResponse(ws, pack.query, 'wronglogin');
                    //ws.terminate();
                }
            } break;
            case 'relation': {
                let user = USERS[uid],
                    user_b = USERS[pack.user_b];
                if (user_b === undefined) return withResponse(ws, pack.query, ''); // If he is offline

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
                for(let i in pack.list) {
                    for(let j in USERS) {
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
                    isPrivate = pack.private,
                    password = nanoid();

                if (name.length < 1 || name.length > 144) return withResponse(ws, pack.query, 'Too long name.');
                if (participants.length == 0) return withResponse(ws, pack.query, 'No participants.');

                participants.push(owner_id);
                let members = [];
                for(let i in participants) {
                    let rights = participants[i] == owner_id ? 1 : 0; // If it's owner then rights = 1
                    members.push({id: participants[i], rights});
                }
                if (isPrivate) {
                    let conv = await conversation.count({
                        where: {
                            participants: JSON.stringify(members)
                        }
                    });
                    console.log(conv);
                    if (conv > 0) {
                        return withResponse(ws, pack.query, 'Already opened.');
                    }
                }
                let newConv = await conversation.create({
                    owner_id,
                    name,
                    password,
                    participants: JSON.stringify(members)
                });
                let participantsString = '';
                for(let i = 0; i < participants.length; i++) {
                    let p = await selectUser('id', participants[i]); // p -> participant
                    if (p.conversations == null) p.conversations = [];

                    let pc = p.conversations;
                    pc.push({id: newConv.id, password, messagesRead: 0});
                    let pcJson = JSON.stringify(pc);

                    let comma = ', ';
                    if (i == participants.length-1) comma = '';
                    participantsString = participantsString+p.login+comma;

                    if (USERS[participants[i]] != undefined) { // If this user is actually online, then just update the new value
                        USERS[participants[i]].conversations = pc;
                        // Sync online user with new conversation
                        emit(SOCKETS[participants[i]], 'newConversation', {name});
                    }

                    await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                }
                newMessage(newConv.id, -1, `${USERS[uid].login} создал беседу ${newConv.name} с участниками ${participantsString}.`);
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
                            haveRights = false;
                        checkIfHasRights:
                        for(let i in participants) {
                            if (participants[i].id == uid && participants[i].rights == 1) {
                                haveRights = true;
                                break checkIfHasRights;
                            }
                        }

                        if (!haveRights) return withResponse(ws, pack.query, 'У вас нет прав.');

                        let addMembers = [];
                        for(let i in addIds) {
                            if (addIds[i] == uid) continue;
                            participants.push({id: addIds[i], rights: 0, enteredDate: moment()});

                            let p = await selectUser('id', addIds[i]); // p -> participant
                            addMembers.push({id: p.id, login: p.login, fullname: p.fullname});
                            if (p.conversations == null) p.conversations = [];
                            let pc = p.conversations;
                            pc.push({id: conv.id, password: conv.password, messagesRead: 0});
                            let pcJson = JSON.stringify(pc);
                            await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                            newMessage(conv_id, -1, `${USERS[uid].login} добавил ${p.login} в беседу.`);
                        }
                        conv.participants = JSON.stringify(participants);
                        await conv.save();
                        
                        for(let i in participants) {
                            let op = participants[i];
                            if (USERS[op.id] != undefined) { // If this user is actually online, then just update the new value
                                // Sync online user with new conversation
                                for(let j in addMembers) {
                                    emit(SOCKETS[op.id], 'addedConversation', {addId: addMembers[j].id, conv_id: conv.id, name: conv.name, addLogin: addMembers[j].login, addFullname: addMembers[j].fullname});
                                }
                            }
                        }
                        response = 'added';
                    } break;
                    case 'kick': {
                        let kickId = data.kickId,
                            participants = JSON.parse(conv.participants),
                            haveRights = false;
                        checkIfHasRights:
                        for(let i in participants) {
                            if (participants[i].id == uid && participants[i].rights == 1) {
                                haveRights = true;
                                break checkIfHasRights;
                            }
                        }
                        if (kickId == uid) haveRights = true; // Kick myself = leave
                        if (!haveRights) return withResponse(ws, pack.query, 'У вас нет прав.');
                        removeProcess:
                        for(let i in participants) {
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
                        for(let i in pc) {
                            if (pc[i].id == conv_id) {
                                pc.splice(i, 1);
                                break removeFromUsersTable;
                            }
                        }
                        let pcJson = JSON.stringify(pc);
                        
                        await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                        
                        participants.unshift({id: kickId});
                        for(let i in participants) {
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
                for(let i in pc) {
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
                    hash = pack.hash,
                    otherData = {};
                
                if (pack.type != undefined) {
                    otherData = {type: pack.type, filename: pack.filename, originalname: pack.originalname, filesize: pack.filesize};
                }
                newMessage(conv_id, owner_id, text, hash, ws, otherData);
            } break;
            case 'readMessage': {
                let conv_id = pack.conv_id,
                    messagesRead = pack.messagesRead;
                
                await updateMe(USERS[uid]); // Sync user data with real data
                let user = USERS[uid],
                    pc = user.conversations;
                for(let i in pc) {
                    if (pc[i].id == conv_id) {
                        pc[i].messagesRead = messagesRead;
                        let pcJson = JSON.stringify(pc);
                        await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, user.id]});
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
            case 'adminBroadcast': {
                let message = pack.message;
                await updateMe(USERS[uid]);
                if (USERS[uid].status < 1) return withResponse(ws, pack.query, 'У вас нет прав.');
                for(let i in USERS) {
                    emit(SOCKETS[USERS[i].id], 'announce', {type: 'I', admin_id: uid, message: `Администратор ${USERS[uid].login}: ${message}`});
                }
            } break;
            case 'videoCall': {
                let action = pack.action;
                switch(action) {
                    case 'newRoom': {
                        let roomid = nanoid();
                        CALLROOMS[roomid] = new CallRoom(roomid);
                        let room = CALLROOMS[roomid];
                        room.newMember(USERS[uid].id, USERS[uid].login, USERS[uid].peer);
                        
                        response = roomid;
                    } break;
                    case 'inviteRoom': {
                        let roomid = pack.roomid,
                            members = pack.members,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.query, 'Комната не существует.');
                        members.forEach(e => {
                            if (room.members.findIndex(i => i.id == e) != -1) return;
                            if (SOCKETS[e] === undefined || e == uid) return;
                            emit(SOCKETS[e], 'videocall_incoming', {userid: uid, caller: USERS[uid].login, roomid});
                            room.ringingList.push({id: e, login: USERS[e].login});
                        });
                        response = room;
                    } break;
                    case 'joinRoom': {
                        let roomid = pack.roomid,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.query, 'Комната не существует.');
                        room.newMember(USERS[uid].id, USERS[uid].login, USERS[uid].peer);
                        response = room;
                    } break;
                    case 'declineRoom': {
                        let roomid = pack.roomid,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.query, 'Комната не существует.');
                        room.deleteRinglist(uid);
                        room.members.forEach(e => {
                            if (!SOCKETS[e.id]) return;
                            emit(SOCKETS[e.id], 'videocall_leftMember', {id: uid});
                        });
                    } break;
                    case 'leaveRoom': {
                        let roomid = SOCKETS[uid].callroom,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.query, 'Комната не существует.');
                        room.deleteMember(USERS[uid].id);
                        response = '';
                    } break;
                }
            } break;
            // Peers
            case 'peerConnect': {
                let peer_id = pack.id;
                USERS[uid].peer = peer_id;
            } break;
            case 'peersGet': {
                let users_list = pack.users,
                    peers = [];
                for(let i in users_list) {
                    if (USERS[users_list[i]] != undefined) {
                        peers.push({peer: USERS[users_list[i]].peer, user_id: users_list[i]});
                    }
                }
                response = peers;
            } break;
            case 'cpuInfo': {
                let cpu = osu.cpu,
                    mem = osu.mem,
                    cpuData = {};
                await cpu.usage().then(info => {cpuData.usage = info});
                await mem.info().then(info => {cpuData.mem = info});
                response = cpuData;
            } break;
            // Volunteers
            case 'volAuth': {
                let index = VOLS.findIndex(e => e.id == uid);
                if (index != -1) return withResponse(ws, pack.query, 'already');
                VOLS.push({id: uid, peer_id: pack.peer_id});
                console.log(VOLS)
                response = 'hello';
            } break;
            case 'getFreeVOL': {
                console.log(VOLS)
                if (VOLS.length == 0) return withResponse(ws, pack.query, 'Нет свободных волонтеров.');
                response = VOLS[0];
            } break;
            case 'spacepen': {
                let action = pack.action;
                console.log(action);
                switch(action) {
                    case 'newpen': {
                        let penid = nanoid();
                        let ind = PENS.push(new Pen(penid)),
                            pen = PENS[ind-1];
                        pen.newMember(uid, USERS[uid].login, USERS[uid].peer);
                        response = {penid};
                    } break;
                    case 'joinpen': {
                        let penid = pack.penid;
                        let ind = PENS.findIndex(e => e.id == penid);
                        if (ind == -1) return withResponse(ws, pack.query, 'Pen не существует.');
                        let pen = PENS[ind];
                        pen.newMember(uid, USERS[uid].login, USERS[uid].peer);
                        response = {penid, members: pen.members};
                    } break;
                }
            } break;
            // Chess
            case 'chess': {
                let action = pack.action;
                switch(action) {
                    case 'newgame': {
                        let chessid = nanoid();
                        let ind = (CHESSMATCHES.push(new ChessMatch(chessid)))-1;
                        CHESSMATCHES[ind].players.push({id: uid, turn: 1});
                        response = {chessid, board: CHESSMATCHES[ind].board(), turn: 1};
                    } break;
                    case 'joingame': {
                        let chessid = pack.chessid,
                            ind = CHESSMATCHES.findIndex(e => e.id == chessid);
                        if (ind != -1) {
                            let turn = (CHESSMATCHES[ind].players.length+1),
                                pind = CHESSMATCHES[ind].players.findIndex(e => e.id == uid);
                            console.log('My id '+uid);
                            console.log(CHESSMATCHES[ind].players);
                            if (pind != -1) {
                                turn = CHESSMATCHES[ind].players[pind].turn;
                            }
                            else {
                                CHESSMATCHES[ind].players.push({id: uid, turn});
                            }
                            response = {chessid, board: CHESSMATCHES[ind].board(), turn};
                        }
                    } break;
                    case 'moves': {
                        let chessid = pack.chessid,
                            square = pack.from,
                            ind = CHESSMATCHES.findIndex(e => e.id == chessid);
                        if (ind != -1) {
                            let chessmatch = CHESSMATCHES[ind];
                            response = chessmatch.chess.moves({square, verbose: true});
                        }
                    } break;
                    case 'move': {
                        let chessid = pack.chessid,
                            from = pack.from,
                            to = pack.to,
                            ind = CHESSMATCHES.findIndex(e => e.id == chessid);
                        if (ind != -1) {
                            let chessmatch = CHESSMATCHES[ind],
                                turn = chessmatch.chess.move({from, to, promotion: 'q'});

                            if (turn != null) response = {board: CHESSMATCHES[ind].board()};
                            else response = turn;

                            for(let i = 0; i < chessmatch.players.length; i++) {
                                emit(SOCKETS[chessmatch.players[i].id], 'move', {data: response});
                            }
                        }
                    } break;
                }
            } break;
        }
        emit(ws, '&'+pack.query, {response});
        let after = performance.now();
        console.log(USERS[uid]?.login+' made a query. Served in '+(after-before).toFixed(2)+' ms.')
    });
    ws.on('close', function() {
        if (!SOCKETS[uid]) return;

        if (SOCKETS[uid].callroom) {
            let callroom = CALLROOMS[SOCKETS[uid].callroom];
            if (callroom) {
                callroom.deleteMember(uid);
            }
        }
        // If user has more than one tabs, then keep his data
        if (SOCKETS[uid].length > 1) {
            let ind = SOCKETS[uid].findIndex(e => e == ws);
            if (ind != -1) SOCKETS[uid].splice(ind, 1);
        }
        else {
            delete USERS[uid];
            delete SOCKETS[uid];
        }
    });
    ws.on('pong', function() {
        if (USERS[uid] === undefined) return;
        ws.pingAfter = performance.now();
        ws.pingValue = (ws.pingAfter - ws.pingBefore).toFixed(1);
        emit(ws, 'pingValue', {ping: ws.pingValue});
    });
});
async function newMessage(conv_id, owner_id, text, hash, ws, otherData) {
    let haveRights = false;
    if (ws === undefined) haveRights = true;
    if (hash === undefined) hash = 'system';
    if (otherData === undefined) otherData = {type: 'message'};

    // Increment conversation's totalMessages
    let conv = await conversation.findOne({
        where: {
            id: conv_id
        }
    }),
    participants = JSON.parse(conv.participants);

    checkIfHaveRights:
    for(let i in participants) {
        if (participants[i].id == owner_id) {
            haveRights = true;
            break checkIfHaveRights;
        } 
    }
    if (!haveRights) return withResponse(ws, 'newMessage', 'У вас нет прав.');

    conv.totalMessages = conv.totalMessages+1;

    let response = await message.create({
        conv_id,
        owner_id,
        text,
        otherData: JSON.stringify(otherData)
    });
    for(let i in USERS) {
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
                
                let us = USERS[user.id];
                if (us.peer) user_newData.peer = us.peer;

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
    if (!ws) return;
    if (ws[0] === undefined) ws = [ws];
    for(let i = 0; i < ws.length; i++) {
        ws[i].send(JSON.stringify(pack));
    }
}

// Ping check
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.uid === undefined) return;
        ws.ping();
        ws.pingBefore = performance.now();
    });
}, 5000);