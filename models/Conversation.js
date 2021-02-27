module.exports = (Sequelize, sequelize, DataTypes) => {
    const conversation = sequelize.define('conversation', {
        owner_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notEmpty: true
            }
        },
        name: {
            type: DataTypes.STRING
        },
        password: {
            type: DataTypes.STRING
        },
        participants: {
            type: DataTypes.TEXT,
            defaultValue: '[]'
        },
        totalMessages: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        }
    }, {
        timestamps: true
    });
    return conversation;
};