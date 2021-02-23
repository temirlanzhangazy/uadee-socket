module.exports = (sequelize, DataTypes) => {
    const message = sequelize.define('message', {
        owner_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notEmpty: true
            }
        },
        text: {
            type: DataTypes.STRING
        }
    });
    return message;
};