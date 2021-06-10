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

const ACTIVITY_SPACEPEN = 1;
const STATES_PENDING = 0,
    STATES_MEMBER = 1;
require('path');
require('./scripts/randomcolor');

app.get('/', (req, res) => res.send('Nothing to do here.'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models'),
    { Op, QueryTypes } = db.Sequelize,
    { conversation, message, pen } = require('./models');

const wss = new WebSocket.Server({server: server});

const minInterval = 800,
    maxPenaltyPoints = 10000,
    systemQueries = ['recaptcha_chill', 'auth', 'relation', 'readMessage', 'chess']; // Chess <- косяк

const USERS = {},
    SOCKETS = {},
    STOCK = {},
    CALLROOMS = {},
    PENS = {};

let VOLS = [];

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
const colors = [0xb62b6e, 0x9628c6, 0x4374b7, 0xabb8af, 0x98c807, 0xb1a24a, 0xedd812, 0xef9421, 0xd13814];
class Pen {
    constructor(id) {
        if (!id) id = -1;
        this.id = id;
        this.name = '';
        this.members = [];
        this.onlineMembers = [];
        this.data = [];
    }
    async sync(data) {
        return new Promise((resolve) => {
            (async () => {
                let row = await pen.findOne({
                        where: {id: this.id}
                    }),
                    syncData = {
                        members: JSON.stringify(this.members),
                        data: JSON.stringify(this.data)
                    };
                if (row === null) {
                    if (!data.owner_id) return;
                    row = await pen.create({
                        owner_id: data.owner_id,
                        name: data.name,
                        password: data.password,
                        ...syncData
                    });
                }
                else {
                    if (data) { // Was .sync called for initialization
                        this.members = JSON.parse(row.members);
                        this.data = JSON.parse(row.data);
                    }
                    else {
                        await row.update(syncData);
                    }
                }
                this.id = row.id;
                this.password = row.password;
                this.name = row.name;
                resolve(this);
            })();
        });
    }
    async newMember(id, login, peerid, permission) {
        let permissions = {
            moderate: false,
            edit: true,
            invite: true,
            uninvite: false,
            delete: false,
            ...permission
        };
        let newMemberData = {id, login, permissions},
            tempData = {
                peerid,
                color: colors[Math.floor(Math.random() * colors.length)]
            };
        this.onlineMembers.forEach(e => {
            if (!SOCKETS[e.id]) return;
            emit(SOCKETS[e.id], 'pen_newMember', {...newMemberData, ...tempData});
        });
        if (this.onlineMembers.findIndex(e => e.id == id) == -1){
            this.onlineMembers.push({...newMemberData, ...tempData});
        }
        // If invited user is not a member
        if (this.members.findIndex(e => e.id == id) === -1) {
            this.members.push(newMemberData);
        }
        if (USERS[id] != undefined) {
            SOCKETS[id].spacepen = this.id;
        }
        let mem = await selectUser('id', id);
        if (!mem) return;
        let activities = mem.activities,
            ind = activities.findIndex(e => e.activity == ACTIVITY_SPACEPEN && e.id == this.id);
        if (ind != -1) activities.splice(ind, 1);
        activities.push({activity: ACTIVITY_SPACEPEN, state: STATES_MEMBER, id: this.id, password: this.password});
        await db.sequelize.query(`UPDATE users SET activities = ? WHERE id = ?`, {replacements: [JSON.stringify(activities), mem.id]});

        this.sync();
    }
    deleteMember(id, remove) {
        if (remove) {
            let mind = this.members.findIndex(e => e.id == id);
            if (mind != -1) {
                this.members.splice(mind, 1);
            }
        }
        let ind = this.onlineMembers.findIndex(e => e.id == id);
        if (ind == -1) return;
        this.onlineMembers.forEach(e => {
            if (!SOCKETS[e.id]) return;
            emit(SOCKETS[e.id], 'pen_leftMember', {id, remove});
        });
        this.onlineMembers.splice(ind, 1);
        // If room is empty now
        if (this.onlineMembers.length == 0) {
            delete PENS[this.id];
        }
    }
    async updateMember(uid, memberid, options) {
        let myind = this.members.findIndex(e => e.id == uid);
        if (myind == -1) return;
        let updater = this.members[myind];

        let ind = this.members.findIndex(e => e.id == memberid);
        if (ind == -1) return;
        let member = this.members[ind];
        switch (options.action) {
            case 'remove': {
                if (!updater.permissions.uninvite) return;
                let mem = await selectUser('id', member.id);
                if (!mem) return;
                let activities = mem.activities,
                    ind = activities.findIndex(e => e.activity == ACTIVITY_SPACEPEN && e.id == this.id);
                if (ind != -1) activities.splice(ind, 1);
                await db.sequelize.query(`UPDATE users SET activities = ? WHERE id = ?`, {replacements: [JSON.stringify(activities), mem.id]});

                this.deleteMember(mem.id, true);
            } break;
            default: {
                if (!updater.permissions.moderate) return;
                member.permissions = {
                    ...member.permissions,
                    ...options
                }
                
                this.onlineMembers.forEach(e => {
                    if (!SOCKETS[e.id]) return;
                    emit(SOCKETS[e.id], 'pen_updatePermissions', {id: memberid, options});
                });
                this.sync();
            } break;
        }
        this.sync();
    }
    async update(action, data) {
        switch(action) {
            case 'deleteobjects':
                data.forEach(e => {
                    let ind = this.data.findIndex(i => i.objectid == e);
                    if (ind != -1) {
                        this.data.splice(ind, 1);
                    }
                });
            break;
            default:
                data.forEach(e => {
                    let ind = this.data.findIndex(i => i.objectid == e.objectid);
                    if (ind != -1) {
                        let obj = this.data[ind];
                        if (e.pos) obj.pos = e.pos;
                        if (e.text) obj.text = e.text;
                        if (e.textStyles) obj.textStyles = e.textStyles;
                    }
                    else {
                        this.data.push(e);
                    }
                });
            break;
        }
        pen.update({data: JSON.stringify(this.data)}, {where: {id: this.id, password: this.password}});
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
                case -2: emit(ws, 'recaptcha'); return withResponse(ws, pack.hash, 'suspicious');
                case undefined: return withResponse(ws, pack.hash, 'No STOCK inspection.');
            }
        }
        // POLICE CHECK: Okay sir, зря быканул \\

        let before = performance.now();
        if (pack.query != 'auth' && uid == -1) return withResponse(ws, pack.hash, pack.query+'is declined. No authorization.');
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
                    //if (USERS[pack.id] != undefined) return withResponse(ws, pack.hash, 'alreadysignedin');
                    let newUser = await selectUser('login', pack.login);
                    if (!newUser) return;
                    if (newUser.password != pack.password) return withResponse(ws, pack.hash, 'Wrong user login or password.');
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
                    return withResponse(ws, pack.hash, 'wronglogin');
                    //ws.terminate();
                }
            } break;
            case 'relation': {
                let user = USERS[uid],
                    user_b = USERS[pack.user_b];
                if (user_b === undefined) return withResponse(ws, pack.hash, ''); // If he is offline

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
                let alreadyExists = false;
                if (name.length < 1 || name.length > 144) return withResponse(ws, pack.hash, 'Too long name.');
                if (participants.length == 0) return withResponse(ws, pack.hash, 'No participants.');

                participants.push(owner_id);
                let members = [];
                for(let i in participants) {
                    let rights = participants[i] == owner_id ? 1 : 0; // If it's owner then rights = 1
                    members.push({id: participants[i], rights});
                }
                if (isPrivate) {
                    let conv = await conversation.findOne({
                        where: {
                            participants: JSON.stringify(members)
                        }
                    });
                    console.log(conv);
                    if (conv !== null) {
                        response = conv;
                        alreadyExists = true;
                    }
                }
                if (!alreadyExists) {
                    let newConv = await conversation.create({
                        owner_id,
                        name,
                        password,
                        participants: JSON.stringify(members)
                    });
                    let participantsString = '';
                    for(let i = 0; i < participants.length; i++) {
                        let p = await selectUser('id', participants[i]); // p -> participant
                        if (!p) return;
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
                }
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

                        if (!haveRights) return withResponse(ws, pack.hash, 'У вас нет прав.');

                        let addMembers = [];
                        for(let i in addIds) {
                            if (addIds[i] == uid) continue;
                            participants.push({id: addIds[i], rights: 0, enteredDate: moment()});

                            let p = await selectUser('id', addIds[i]); // p -> participant
                            if (!p) return;
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
                        if (!haveRights) return withResponse(ws, pack.hash, 'У вас нет прав.');
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
                        if (!p) return;
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
                if (USERS[uid].status < 1) return withResponse(ws, pack.hash, 'У вас нет прав.');
                for(let i in USERS) {
                    emit(SOCKETS[USERS[i].id], 'announce', {type: 'I', admin_id: uid, message: `Администратор ${USERS[uid].login}: ${message}`});
                }
            } break;
            case 'videoCall': {
                let action = pack.action;
                switch(action) {
                    case 'newRoom': {
                        let roomid = pack.conv_id,
                            roomData = {roomid, isNew: true};
                        if (CALLROOMS[roomid]) { // If room already exists
                            roomData.isNew = false;
                        }
                        else {
                            CALLROOMS[roomid] = new CallRoom(roomid);
                        }
                        let room = CALLROOMS[roomid];
                        room.newMember(USERS[uid].id, USERS[uid].login, USERS[uid].peer, {});
                        
                        response = roomData;
                    } break;
                    case 'roomExists': {
                        let roomid = pack.conv_id,
                            roomData = {exists: false};
                        if (CALLROOMS[roomid]) {
                            roomData.exists = true;
                            roomData.members = CALLROOMS[roomid].members;
                        }
                        console.log(roomData);
                        response = roomData;
                    } break;
                    case 'inviteRoom': {
                        let roomid = pack.roomid,
                            members = pack.members,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.hash, 'Комната не существует.');
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
                        if (!room) return withResponse(ws, pack.hash, 'Комната не существует.');
                        room.newMember(USERS[uid].id, USERS[uid].login, USERS[uid].peer);
                        response = room;
                    } break;
                    case 'declineRoom': {
                        let roomid = pack.roomid,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.hash, 'Комната не существует.');
                        room.deleteRinglist(uid);
                        room.members.forEach(e => {
                            if (!SOCKETS[e.id]) return;
                            emit(SOCKETS[e.id], 'videocall_leftMember', {id: uid});
                        });
                    } break;
                    case 'leaveRoom': {
                        let roomid = SOCKETS[uid].callroom,
                            room = CALLROOMS[roomid];
                        if (!room) return withResponse(ws, pack.hash, 'Комната не существует.');
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
                if (index != -1) return withResponse(ws, pack.hash, 'already');
                VOLS.push({id: uid, peer_id: pack.peer_id});
                console.log(VOLS)
                response = 'hello';
            } break;
            case 'getFreeVOL': {
                console.log(VOLS)
                if (VOLS.length == 0) return withResponse(ws, pack.hash, 'Нет свободных волонтеров.');
                response = VOLS[0];
            } break;
            case 'spacepen': {
                let action = pack.action;
                switch(action) {
                    case 'newpen': {
                        let pens = new Pen(),
                            name = pack.name,
                            password = nanoid();
                        await pens.sync({
                            owner_id: uid,
                            password,
                            name
                        });
                        PENS[pens.id] = pens;
                        pens.newMember(uid, USERS[uid].login, USERS[uid].peer, {
                            moderate: true,
                            edit: true,
                            invite: true,
                            uninvite: true,
                            delete: true
                        });
                        await pens.sync();
                        response = pens;
                    } break;
                    case 'invitepen': {
                        let penid = pack.penid,
                            members = pack.members,
                            pens = PENS[penid];
                        if (!pens) return withResponse(ws, pack.hash, 'Pen не существует.');

                        let ind = pens.members.findIndex(e => e.id == uid);
                        if (ind == -1) return;
                        let member = pens.members[ind];
                        if (!member.permissions.invite) return withResponse(ws, pack.hash, 'У вас нет прав на приглашение в этот Pen.');

                        members.forEach(async (e) => {
                            let mem = await selectUser('id', e);
                            if (!mem) return;
                            let activities = mem.activities,
                                ind = activities.findIndex(e => e.activity == ACTIVITY_SPACEPEN && e.id == pens.id);
                            if (ind == -1) {
                                activities.push({activity: ACTIVITY_SPACEPEN, state: STATES_PENDING, id: pens.id, password: pens.password});
                                await db.sequelize.query(`UPDATE users SET activities = ? WHERE id = ?`, {replacements: [JSON.stringify(activities), e]});
                                if (SOCKETS[e]) {
                                    emit(SOCKETS[e], 'pen_invite', {id: pens.id, password: pens.password, name: pens.name, updatedAt: moment()});
                                }
                            }
                        });
                        response = 'OK';
                    } break;
                    case 'updatemember': {
                        let penid = pack.penid,
                            member = pack.memberid,
                            options = pack.options,
                            pens = PENS[penid];
                        if (!pens) return withResponse(ws, pack.hash, 'Pen не существует.');
                        pens.updateMember(uid, member, options);
                    } break;
                    case 'disconnect': {
                        let spacepen = PENS[SOCKETS[uid].spacepen];
                        if (spacepen) {
                            spacepen.deleteMember(uid);
                        }
                    } break;
                    case 'getMyPens': {
                        await updateMe(USERS[uid]); // Sync user data with real data
                        let user = USERS[uid],
                            conds = [],
                            acts = user.activities,
                            userActs = {};
                        for(let i in acts) {
                            if (acts[i].activity != ACTIVITY_SPACEPEN) continue;
                            if (!acts[i].id) continue;
                            conds.push({id: acts[i].id, password: acts[i].password});
                            userActs[acts[i].id] = acts[i];
                        }
                        let list = await pen.findAll({
                            where: {
                                [Op.or]: conds
                            },
                            order: [
                                ['updatedAt', 'DESC']
                            ]
                        });
                        response = [];
                        for(let i = 0; i < list.length; i++) {
                            let l = list[i];
                            if (!userActs[l.id]) continue;
                            
                            let memberData = JSON.parse(l.members),
                                ind = memberData.findIndex(e => e.id == uid);
                            response.push({id: l.id, name: l.name, password: l.password, data: userActs[l.id], memberData: ind == -1 ? null : memberData[ind], updatedAt: l.updatedAt});
                        }
                    } break;
                    case 'joinpen': {
                        let penid = pack.penid,
                            password = pack.password,
                            pens = PENS[penid];
                        
                        await updateMe(USERS[uid]); // Sync user data with real data
                        let user = USERS[uid],
                            ind = user.activities.findIndex(i => (i.activity == ACTIVITY_SPACEPEN && i.id == penid && i.password == password));
                        if (ind == -1) return withResponse(ws, pack.hash, 'У Вас нет прав вступать в этот Pen.');
                        let row = await pen.findOne({
                            where: {id: penid, password}
                        });
                        if (row === null) return withResponse(ws, pack.hash, 'Pen не существует.');
                        if (!pens) {
                            pens = new Pen(penid);
                            await pens.sync(true); // Create a new Pen from database
                        }
                        PENS[pens.id] = pens;
                        pens.newMember(uid, USERS[uid].login, USERS[uid].peer);
                        response = pens;
                    } break;
                    default: {
                        let penid = SOCKETS[uid].spacepen,
                            data = pack.data,
                            memberid = uid,
                            pens = PENS[penid];
                        let ind = pens.members.findIndex(e => e.id == memberid);
                        if (ind == -1) return;
                        let member = pens.members[ind];

                        if (!member.permissions.edit) return withResponse(ws, pack.hash, 'У вас нет прав на редактирование этого Pen.');
                        pens.update(action, data);
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
        emit(ws, '&'+pack.hash, {response});
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
        if (SOCKETS[uid].spacepen) {
            let spacepen = PENS[SOCKETS[uid].spacepen];
            if (spacepen) {
                spacepen.deleteMember(uid);
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
                if (typeof USERS[user.id].activities == 'string') {
                    USERS[user.id].activities = JSON.parse(USERS[user.id].activities);
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
    return new Promise((resolve) => {
        db.sequelize.query(`SELECT * FROM users WHERE ${type} = ? LIMIT 1`, { type: QueryTypes.SELECT, replacements: [login] }).then((query) => {
            // If found someone
            if (query.length > 0) {
                let user = query[0];
                user.conversations = JSON.parse(user.conversations);
                user.activities = JSON.parse(user.activities);
                resolve(user);
            }
            else {
                resolve(undefined);
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