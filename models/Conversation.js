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
        totalMessages: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        creationTime: {
            type: DataTypes.DATE,
            defaultValue: Sequelize.NOW
        },
        updatedTime: {
            type: DataTypes.DATE,
            defaultValue: Sequelize.NOW
        }
    }, {
        timestamps: false
    });
    return conversation;
};