const { Sequelize, DataTypes } = require("sequelize");

const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

let sequelize;
if (MYSQL_ADDRESS) {
  // 云托管环境：使用 MySQL
  const [host, port] = MYSQL_ADDRESS.split(":");
  sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
    host,
    port,
    dialect: "mysql",
  });
} else {
  // 本地开发：使用 SQLite
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: "./data.sqlite",
    logging: false,
  });
}

// 表情包图片表
const Image = sequelize.define("Image", {
  id: {
    type: DataTypes.STRING(32),
    primaryKey: true,
  },
  openid: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  picUrl: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: "微信CDN图片地址",
  },
  mediaId: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "微信素材ID",
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "本地存储路径",
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: "image/png",
  },
});

async function init() {
  await Image.sync({ alter: true });
}

module.exports = {
  init,
  Image,
};
