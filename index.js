const { performance } = require('perf_hooks'),
    express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    WebSocket = require('ws'),
    { nanoid } = require('nanoid'),
    port = 4000;

app.locals.moment = require('moment'),
app.get('/', (req, res) => res.send('Hello World!'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models');
const { Op, QueryTypes } = db.Sequelize;

const { conversation, message } = require('./models');

db.sequelize.sync({alter: true}).then(async (req) => {
    console.log('Sequalize started successfully.');
});

const wss = new WebSocket.Server({server: server});

let USERS = {},
    SOCKETS = {};

wss.on('connection', function(ws) {
    let uid = -1;

    ws.on('message', async function(data) {
        let before = performance.now();
        // WARNING, NO RETURN. ELSE USER WILL STILL WAIT FOR RESPONSE
        let pack = JSON.parse(data),
            response = null;
        if (pack.query != 'auth' && uid == -1) return withResponse(ws, pack.query, 'No authorization.');
        switch(pack.query) {
            case 'auth': {
                // pack.login, pack.password
                try {
                    if (USERS[pack.id] != undefined) return withResponse(ws, pack.query, 'Already signed in.');
                    let newUser = await selectUser('login', pack.login);
                    if (newUser.password != pack.password) return withResponse(ws, pack.query, 'Wrong user login or password.');
                    uid = newUser.id;
                    USERS[uid] = newUser;
                    SOCKETS[uid] = ws;
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
                let newConv = await conversation.create({
                    owner_id,
                    name,
                    password
                });
                participants.push(owner_id);
                for(i in participants) {
                    let p = await selectUser('id', participants[i]); // p -> participant
                    if (p.conversations == null) p.conversations = JSON.stringify([]);

                    let pc = p.conversations;
                    pc.push({id: newConv.id, password, messagesRead: 0});
                    let pcJson = JSON.stringify(pc);

                    if (USERS[participants[i]] != undefined) { // If this user is actually online, then just update the new value
                        USERS[participants[i]].conversations = pc;
                        // Sync online user with new conversation
                        emit(SOCKETS[participants[i]], 'newConversation');
                    }

                    const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [pcJson, p.id]});
                }
                response = newConv;
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
                    }
                });
            } break;
            case 'newMessage': {
                // pack.conv_id, pack.text
                let conv_id = pack.conv_id,
                    owner_id = uid,
                    text = pack.text;
                response = await message.create({
                    conv_id,
                    owner_id,
                    text
                });
                for(i in USERS) {
                    let iu = USERS[i],
                        convs = iu.conversations;
                    if (convs.filter(e => convs.id == conv_id)) {
                        emit(SOCKETS[iu.id], 'updateConversation', {newMessage: response});
                    }
                }
                // Increment conversation's totalMessages
                let conv = await conversation.findOne({
                    where: {
                        id: conv_id
                    }
                });
                conv.totalMessages = conv.totalMessages+1;
                await conv.save();
            } break;
            case 'readMessage': {
                let conv_id = pack.conv_id,
                    messagesRead = pack.messagesRead;
                
                await updateMe(USERS[uid]); // Sync user data with real data
                let user = USERS[uid],
                    pc = user.conversations;
                console.log(pc);
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
                    }
                });
            } break;
        }
        emit(ws, '&'+pack.query, {response});
        let after = performance.now();
        console.log('A query was served in '+(after-before).toFixed(2)+' ms.')
    });
    ws.on('close', function(close) {
        delete USERS[uid];
        delete SOCKETS[uid];
    });
});
function withResponse(ws, query, response) {
    if (response === undefined) response = 'error';
    emit(ws, '&'+query, {response});
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