const express = require('express'),
    app = express(),
    server = require('http').createServer(app),
    WebSocket = require('ws'),
    port = 4000;

const wss = new WebSocket.Server({server: server});

let USERS = {};
wss.on('connection', function(ws) {
    let uid = -1,
        user;

    ws.on('message', async function(data) {
        let pack = JSON.parse(data);
        if (pack.query != 'auth' && user === undefined) return;
        switch(pack.query) {
            case 'auth':
                // pack.login, pack.password
                try {
                    let newUser = await selectUser(pack.login, pack.password);
                    uid = newUser.id;
                    USERS[uid] = newUser;
                    USERS[uid].ws = ws;
                    user = USERS[uid];
                    emit(ws, 'online');
                } catch (e) {
                    // Login or password is wrong (normally its impossible, because client sends after auth)
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
        }
    });
    ws.on('close', function(close) {
        delete USERS[uid];
    });
});

app.get('/', (req, res) => res.send('Hello World!'));

server.listen(port, () => console.log(`Listening on the port ${port}`));

const db = require('./models');
const { QueryTypes } = db.Sequelize;

// const { user } = require('./models');

// db.sequelize.sync().then(async (req) => {
//     console.log('Sequalize stated successfully.');
//     const users = await user.findAll();
//     console.log("All users:", JSON.stringify(users, null, 2));
// });
async function selectUser(login, password) {
    return new Promise((resolve, reject) => {
        db.sequelize.query("SELECT * FROM `users` WHERE login = ? AND password = ? LIMIT 1", { type: QueryTypes.SELECT, replacements: [login, password] }).then((query) => {
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