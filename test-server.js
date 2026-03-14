import express from "express";
import fs from "fs/promises";
import path from "path";

const DB_FILE = path.join(process.cwd(), 'database.json');

async function readDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { patients: [], sessions: [], notes: [] };
  }
}

const app = express();
app.get("/api/db", async (req, res) => {
  console.log("Hit /api/db");
  const db = await readDB();
  console.log("DB read successfully");
  res.json(db);
});
app.listen(3001, () => console.log("Test server running on 3001"));
