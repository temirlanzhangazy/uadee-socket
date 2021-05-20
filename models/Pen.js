module.exports = (Sequelize, sequelize, DataTypes) => {
    const pen = sequelize.define('pen', {
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
        members: {
            type: DataTypes.TEXT,
            defaultValue: '[]'
        },
        data: {
            type: DataTypes.TEXT('long')
        }
    }, {
        timestamps: true
    });
    return pen;
};