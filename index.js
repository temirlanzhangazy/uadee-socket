const express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    WebSocket = require('ws'),
    { nanoid } = require('nanoid'),
    port = 4000;

app.locals.moment = require('moment'),
app.get('/', (req, res) => res.send('Hello World!'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models');
const { QueryTypes } = db.Sequelize;

const { conversation } = require('./models');

db.sequelize.sync({alter: true}).then(async (req) => {
    console.log('Sequalize started successfully.');
});

const wss = new WebSocket.Server({server: server});

let USERS = {};
wss.on('connection', function(ws) {
    let uid = -1,
        user;

    ws.on('message', async function(data) {
        let pack = JSON.parse(data),
            response = null;
        if (pack.query != 'auth' && user === undefined) return;
        switch(pack.query) {
            case 'auth':
                // pack.login, pack.password
                try {
                    let newUser = await selectUser('login', pack.login);
                    if (newUser.password != pack.password) return;
                    uid = newUser.id;
                    USERS[uid] = newUser;
                    USERS[uid].ws = ws;
                    user = USERS[uid];
                    emit(ws, 'online');
                } catch (e) {
                    // Login is wrong (normally its impossible, because client sends after auth)
                    ws.terminate();
                }
            break;
            case 'relation':
                let user_b = USERS[pack.user_b];
                if (user_b === undefined) return; // If he is offline

                let relationStatus = pack.relationStatus,
                    message;
                switch(relationStatus) {
                    case '-2': message = user.login+' удалил Вас из друзей.'; break;
                    case '-1': message = user.login+' отклонил заявку в друзья.'; break;
                    case '0': message = user.login+' хочет добавить Вас в друзья.'; break;
                    case '2': message = user.login+' принял Вашу заявку в друзья.'; break;
                    default: break;
                }
                emit(user_b.ws, 'announce', {type: 'I', message});
            break;
            case 'getUsers':
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
            break;
            case 'newConversation':
                let owner_id = user.id,
                    name = pack.name,
                    participants = pack.participants,
                    password = nanoid();

                if (name.length < 1 || name.length > 144) return;
                let newConv = await conversation.create({
                    owner_id,
                    name,
                    password
                });
                participants.push(owner_id);
                for(i in participants) {
                    let p = await selectUser('id', participants[i]); // p -> participant
                    if (p.conversations == null) p.conversations = JSON.stringify([]);

                    let pc = JSON.parse(p.conversations);
                    pc.push({id: newConv.id, password});
                    const [results, metadata] = await db.sequelize.query(`UPDATE users SET conversations = ? WHERE id = ?`, {replacements: [JSON.stringify(pc), p.id]});
                }
                response = newConv;
            break;
        }
        emit(ws, '&'+pack.query, {response});
    });
    ws.on('close', function(close) {
        delete USERS[uid];
    });
});

async function selectUser(type, login) {
    return new Promise((resolve, reject) => {
        db.sequelize.query(`SELECT * FROM users WHERE ${type} = ? LIMIT 1`, { type: QueryTypes.SELECT, replacements: [login] }).then((query) => {
            // If found someone
            if (query.length > 0) {
                let user = query[0];
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