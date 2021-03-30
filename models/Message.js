module.exports = (Sequelize, sequelize, DataTypes) => {
    const message = sequelize.define('message', {
        conv_id: {
            type: DataTypes.INTEGER
        },
        owner_id: {
            type: DataTypes.INTEGER
        },
        text: {
            type: DataTypes.STRING
        },
        otherData: {
            type: DataTypes.TEXT
        }
    });
    return message;
};