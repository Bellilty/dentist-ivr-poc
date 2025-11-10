// api/audio/[file].js
import path from "path";
import fs from "fs";

export default function handler(req, res) {
  const { file } = req.query;
  const filePath = path.join(process.cwd(), "api/audio", file);

  if (!fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  fs.createReadStream(filePath).pipe(res);
}
