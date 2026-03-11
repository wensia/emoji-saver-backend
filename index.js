const Koa = require("koa");
const Router = require("koa-router");
const logger = require("koa-logger");
const bodyParser = require("koa-bodyparser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { init: initDB, Image } = require("./db");

const router = new Router();

// 配置
const BASE_URL = process.env.BASE_URL || "";
const UPLOAD_DIR = path.join(__dirname, "uploads");

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 生成短ID
function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ==================== 微信公众号消息推送（JSON 模式） ====================

router.post("/wx", async (ctx) => {
  const msg = ctx.request.body;

  console.log("收到微信消息:", JSON.stringify(msg));

  const { MsgType, FromUserName, ToUserName } = msg;

  // 只处理图片消息
  if (MsgType !== "image") {
    ctx.body = {
      ToUserName: FromUserName,
      FromUserName: ToUserName,
      CreateTime: Math.floor(Date.now() / 1000),
      MsgType: "text",
      Content: "请发送表情包图片，我会帮你保存原图哦~",
    };
    return;
  }

  const { PicUrl, MediaId } = msg;

  try {
    const id = generateId();

    // 下载图片
    const response = await axios.get(PicUrl, {
      responseType: "arraybuffer",
      timeout: 4000,
    });
    const buffer = Buffer.from(response.data);

    // 检测图片类型
    const contentType = response.headers["content-type"] || "image/png";
    const ext = contentType.includes("gif")
      ? ".gif"
      : contentType.includes("jpeg")
        ? ".jpg"
        : ".png";
    const fileName = `${id}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    // 保存文件
    fs.writeFileSync(filePath, buffer);

    // 保存到数据库
    await Image.create({
      id,
      openid: FromUserName,
      picUrl: PicUrl,
      mediaId: MediaId,
      filePath: fileName,
      mimeType: contentType,
    });

    const downloadUrl = `${BASE_URL}/download/${id}`;

    ctx.body = {
      ToUserName: FromUserName,
      FromUserName: ToUserName,
      CreateTime: Math.floor(Date.now() / 1000),
      MsgType: "text",
      Content: `表情包已保存！点击查看并保存原图：\n${downloadUrl}`,
    };
  } catch (err) {
    console.error("处理图片失败:", err);
    ctx.body = {
      ToUserName: FromUserName,
      FromUserName: ToUserName,
      CreateTime: Math.floor(Date.now() / 1000),
      MsgType: "text",
      Content: "保存失败了，请稍后重试~",
    };
  }
});

// ==================== 图片接口 ====================

router.get("/api/image/:id", async (ctx) => {
  const image = await Image.findByPk(ctx.params.id);
  if (!image) {
    ctx.status = 404;
    ctx.body = { code: -1, msg: "图片不存在" };
    return;
  }
  ctx.body = {
    code: 0,
    data: {
      id: image.id,
      mimeType: image.mimeType,
      url: `${BASE_URL}/api/image/${image.id}/file`,
      createdAt: image.createdAt,
    },
  };
});

router.get("/api/image/:id/file", async (ctx) => {
  const image = await Image.findByPk(ctx.params.id);
  if (!image) {
    ctx.status = 404;
    ctx.body = "图片不存在";
    return;
  }

  const filePath = path.join(UPLOAD_DIR, image.filePath);
  if (fs.existsSync(filePath)) {
    ctx.type = image.mimeType || "image/png";
    ctx.body = fs.createReadStream(filePath);
  } else {
    ctx.redirect(image.picUrl);
  }
});

// ==================== 下载页面 ====================

router.get("/download/:id", async (ctx) => {
  const image = await Image.findByPk(ctx.params.id);
  if (!image) {
    ctx.status = 404;
    ctx.body = "图片不存在或已过期";
    return;
  }

  const imageUrl = `${BASE_URL}/api/image/${image.id}/file`;

  ctx.type = "text/html";
  ctx.body = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>保存表情包</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 30px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      text-align: center;
    }
    h2 { font-size: 18px; color: #333; margin-bottom: 20px; }
    .image-wrap {
      background: #f9f9f9;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .image-wrap img {
      max-width: 100%;
      max-height: 300px;
      border-radius: 8px;
    }
    .tip { color: #999; font-size: 13px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>长按图片保存到相册</h2>
    <div class="image-wrap">
      <img src="${imageUrl}" alt="表情包" />
    </div>
    <p class="tip">长按上方图片 → 保存到手机</p>
  </div>
</body>
</html>`;
});

// ==================== 健康检查 ====================

router.get("/", async (ctx) => {
  ctx.body = { code: 0, msg: "表情包存图服务运行中" };
});

// ==================== 启动应用 ====================

const app = new Koa();
app
  .use(logger())
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods());

const port = process.env.PORT || 80;
async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}
bootstrap();
