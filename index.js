const Koa = require("koa");
const Router = require("koa-router");
const logger = require("koa-logger");
const bodyParser = require("koa-bodyparser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
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

// ==================== 解析消息（兼容 JSON 和 XML） ====================

async function parseWxMessage(ctx) {
  const body = ctx.request.body;

  // 已经是 JSON 对象（被 raw body 中间件解析过）
  if (typeof body === "object" && body !== null) {
    return body;
  }

  // 字符串：尝试 XML 解析
  if (typeof body === "string" && body.trim().startsWith("<")) {
    const result = await parseStringPromise(body, { explicitArray: false });
    return result.xml;
  }

  // 兜底
  return body || {};
}

// 构建 XML 文本回复
function buildXmlTextReply(fromUser, toUser, content) {
  const timestamp = Math.floor(Date.now() / 1000);
  return `<xml>
  <ToUserName><![CDATA[${fromUser}]]></ToUserName>
  <FromUserName><![CDATA[${toUser}]]></FromUserName>
  <CreateTime>${timestamp}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}

// 根据请求类型返回对应格式的响应
function reply(ctx, fromUser, toUser, content) {
  const contentType = ctx.request.headers["content-type"] || "";
  if (contentType.includes("text/xml") || contentType.includes("application/xml")) {
    ctx.type = "text/xml";
    ctx.body = buildXmlTextReply(fromUser, toUser, content);
  } else {
    ctx.body = {
      ToUserName: fromUser,
      FromUserName: toUser,
      CreateTime: Math.floor(Date.now() / 1000),
      MsgType: "text",
      Content: content,
    };
  }
}

// ==================== 微信公众号消息推送 ====================

router.post("/wx", async (ctx) => {
  let msg;
  try {
    msg = await parseWxMessage(ctx);
  } catch (err) {
    console.error("解析消息失败:", err);
    ctx.body = "success";
    return;
  }

  console.log("收到微信消息:", JSON.stringify(msg));

  // 云托管路径检查 or 无效消息，直接返回 success
  if (!msg || !msg.MsgType || msg.action) {
    ctx.body = "success";
    return;
  }

  const { MsgType, FromUserName, ToUserName } = msg;

  // 处理图片和表情消息
  if (MsgType !== "image" && MsgType !== "emoticon") {
    reply(ctx, FromUserName, ToUserName, "请发送表情包图片，我会帮你保存原图哦~");
    return;
  }

  const { PicUrl, MediaId } = msg;

  // emoticon 类型可能没有 PicUrl，需要通过 MediaId 下载
  if (!PicUrl && !MediaId) {
    reply(ctx, FromUserName, ToUserName, "无法获取表情包图片，请重试~");
    return;
  }

  try {
    const id = generateId();

    let buffer;
    let contentType = "image/gif";

    if (PicUrl) {
      // 通过 PicUrl 下载
      const response = await axios.get(PicUrl, {
        responseType: "arraybuffer",
        timeout: 4000,
      });
      buffer = Buffer.from(response.data);
      contentType = response.headers["content-type"] || "image/png";
    } else {
      // 通过 MediaId 从微信 API 下载（云托管内部可免 access_token）
      const mediaUrl = `http://api.weixin.qq.com/cgi-bin/media/get?media_id=${MediaId}`;
      const response = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        timeout: 4000,
      });
      buffer = Buffer.from(response.data);
      contentType = response.headers["content-type"] || "image/gif";
    }

    const ext = contentType.includes("gif")
      ? ".gif"
      : contentType.includes("jpeg")
        ? ".jpg"
        : ".png";
    const fileName = `${id}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    fs.writeFileSync(filePath, buffer);

    await Image.create({
      id,
      openid: FromUserName,
      picUrl: PicUrl || "",
      mediaId: MediaId,
      filePath: fileName,
      mimeType: contentType,
    });

    const downloadUrl = `${BASE_URL}/download/${id}`;
    reply(ctx, FromUserName, ToUserName, `表情包已保存！点击查看并保存原图：\n${downloadUrl}`);
  } catch (err) {
    console.error("处理图片失败:", err);
    reply(ctx, FromUserName, ToUserName, "保存失败了，请稍后重试~");
  }
});

// 微信签名验证 / 路径检查（GET）
router.get("/wx", async (ctx) => {
  const { echostr } = ctx.query;
  ctx.body = echostr || "success";
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
  } else if (image.picUrl) {
    ctx.redirect(image.picUrl);
  } else {
    ctx.status = 404;
    ctx.body = "图片文件不存在";
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

// /wx 路由：先读取 raw body，再统一解析（兼容 JSON 和 XML）
app.use(async (ctx, next) => {
  if (ctx.path === "/wx" && ctx.method === "POST") {
    const rawBody = await new Promise((resolve, reject) => {
      let data = "";
      ctx.req.on("data", (chunk) => (data += chunk));
      ctx.req.on("end", () => resolve(data));
      ctx.req.on("error", reject);
    });
    // 尝试 JSON 解析，失败则保留原始字符串（XML）
    try {
      ctx.request.body = JSON.parse(rawBody);
    } catch {
      ctx.request.body = rawBody;
    }
    return next();
  }
  return next();
});

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
