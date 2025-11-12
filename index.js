import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(morgan("combined"));
app.use(express.json({ limit: "200kb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/hook", (req, res) => {
  const p = req.body || {};
  if (!p.secret || p.secret !== process.env.SHARED_SECRET) {
    return res.status(403).json({ ok:false, error:"Bad secret" });
  }

  console.log("TV ALERT RECEIVED:", JSON.stringify(p));

  return res.status(200).json({ ok:true });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Webhook started on port", port));
