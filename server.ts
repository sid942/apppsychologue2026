import express from "express";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key-for-dev";

// Initialize SQLite database
const dbPath = path.join(process.cwd(), 'app.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  );
`);

// Authentication Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log("authenticateToken - Header:", authHeader ? "Present" : "Missing");

  if (token == null) {
    console.log("authenticateToken - No token");
    return res.status(401).json({ error: "Non autorisé" });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      console.log("authenticateToken - JWT Verify Error:", err.message);
      return res.status(403).json({ error: "Token invalide" });
    }
    console.log("authenticateToken - Success for user:", user.id);
    req.user = user;
    next();
  });
};

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit for large transcriptions
  app.use(express.json({ limit: '50mb' }));

  // API Routes
  app.get("/api/health", (req, res) => {
    console.log("Health check requested");
    res.json({ status: "ok" });
  });

  // --- Auth Routes ---
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password, name } = req.body;
      
      if (!email || !password || !name) {
        return res.status(400).json({ error: "Tous les champs sont requis" });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères" });
      }

      const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (existingUser) {
        return res.status(400).json({ error: "Cet email est déjà utilisé" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const userId = uuidv4();

      db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(userId, email, passwordHash, name);
      
      // Initialize empty data for the user
      const defaultData = { patients: [], sessions: [], notes: [], tasks: [], documents: [], appointments: [] };
      db.prepare('INSERT INTO user_data (user_id, data_json) VALUES (?, ?)').run(userId, JSON.stringify(defaultData));

      const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
      
      res.json({ token, user: { id: userId, email, name } });
    } catch (error) {
      console.error("Register error:", error);
      res.status(500).json({ error: "Erreur lors de l'inscription" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
      if (!user) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect" });
      }

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect" });
      }

      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
      
      res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Erreur lors de la connexion" });
    }
  });

  app.get("/api/auth/me", authenticateToken, (req: any, res) => {
    console.log("Auth me request for user:", req.user.id);
    try {
      const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.id);
      console.log("Auth me user:", user);
      if (!user) return res.status(404).json({ error: "Utilisateur non trouvé" });
      res.json({ user });
    } catch (error) {
      console.error("Auth me error:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
  });

  // --- Database Routes (Protected) ---
  app.get("/api/db", authenticateToken, (req: any, res) => {
    try {
      const row = db.prepare('SELECT data_json FROM user_data WHERE user_id = ?').get(req.user.id) as any;
      if (row) {
        res.json(JSON.parse(row.data_json));
      } else {
        res.json({ patients: [], sessions: [], notes: [], tasks: [], documents: [], appointments: [] });
      }
    } catch (error) {
      console.error("Get DB error:", error);
      res.status(500).json({ error: "Erreur lors de la récupération des données" });
    }
  });

  app.post("/api/db", authenticateToken, (req: any, res) => {
    try {
      db.prepare(`
        INSERT INTO user_data (user_id, data_json, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET 
        data_json = excluded.data_json,
        updated_at = CURRENT_TIMESTAMP
      `).run(req.user.id, JSON.stringify(req.body));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Save DB error:", error);
      res.status(500).json({ error: "Erreur lors de la sauvegarde des données" });
    }
  });

  // AI Analysis Route (Perplexity)
  app.post("/api/ai/analyze-session", authenticateToken, async (req: any, res) => {
    try {
      const { transcription, notes, patientContext } = req.body;
      
      const apiKey = "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";

      const prompt = `
        Tu es un expert de la psychologie clinique, tu as aidé des centaines de psychologues. Aujourd'hui, on reçoit un patient, tu vas analyser la conversation (transcription) et les notes prises par le psychologue pendant la séance.
        Soit ultra professionnel, n'invente rien, pas d'hallucinations, fournis des analyses parfaites et cliniquement pertinentes.
        
        RÈGLES STRICTES :
        1. Analyse UNIQUEMENT le contenu de la "Transcription de la séance" et des "Notes du psychologue".
        2. Le "Contexte du patient" est fourni UNIQUEMENT pour ton information générale. NE RÉPÈTE PAS les éléments du contexte dans ton résumé s'ils n'ont pas été explicitement abordés dans la transcription ou les notes d'aujourd'hui.
        3. Si la transcription ou les notes sont très courtes (ex: le patient a juste parlé de sport), ton résumé doit être court et ne parler QUE de sport. N'invente pas de liens avec le contexte.
        4. N'utilise AUCUN prénom ou nom de famille. Utilise uniquement "le patient" ou "la patiente" pour garantir l'anonymat.
        
        Contexte du patient (pour information uniquement, ne pas résumer si non abordé) :
        ${patientContext}
        
        Transcription de la séance d'aujourd'hui (C'EST CELA QUE TU DOIS RÉSUMER) :
        ${transcription}
        
        Notes du psychologue d'aujourd'hui :
        ${notes}
        
        Tu DOIS répondre UNIQUEMENT avec un objet JSON valide ayant EXACTEMENT cette structure (sans aucun commentaire) :
        {
          "moodScore": 5,
          "anxietyScore": 5,
          "energyScore": 5,
          "confidenceScore": 5,
          "opennessScore": 5,
          "summary": "Résumé narratif court et professionnel de la séance.",
          "themes": ["Thème 1", "Thème 2"],
          "evolution": "improving",
          "attentionPoints": ["Point d'attention 1"],
          "suggestedAxes": ["Axe thérapeutique 1"],
          "nextSessionPrep": ["Préparation 1"],
          "soapNote": "Note SOAP (Subjectif, Objectif, Évaluation, Plan) complète et structurée."
        }
        
        Règles pour les scores : de 1 à 10.
        - moodScore : 1 = très mauvaise, 10 = excellente
        - anxietyScore : 1 = très faible, 10 = très élevé
        - energyScore : 1 à 10
        - confidenceScore : 1 à 10
        - opennessScore : 1 à 10
        - evolution : "improving", "stagnating", ou "declining"
      `;

      const response = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [
            { role: "system", content: "You are a helpful clinical assistant. Return ONLY valid JSON. Do not include markdown formatting." },
            { role: "user", content: prompt }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Perplexity API error:", errorText);
        return res.status(response.status).json({ error: "Failed to fetch from Perplexity API" });
      }

      const data = await response.json();
      let content = data.choices[0].message.content;
      
      // Clean up markdown code blocks if present
      content = content.replace(/\`\`\`json/g, "").replace(/\`\`\`/g, "").trim();

      res.json(JSON.parse(content));
    } catch (error) {
      console.error("Error in analyze-session:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // AI Evolution Route (Perplexity)
  app.post("/api/ai/analyze-evolution", authenticateToken, async (req: any, res) => {
    try {
      const { sessionsHistory } = req.body;
      
      const apiKey = "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";

      const prompt = `
        Tu es un expert de la psychologie clinique. Voici l'historique des résumés des séances précédentes d'un patient, classées par ordre chronologique.
        Fais une synthèse de l'évolution psychologique du patient au fil du temps. Dégage les progrès, les stagnations, et la logique d'évolution globale.
        
        RÈGLES STRICTES :
        1. N'utilise AUCUN prénom ou nom de famille. Utilise uniquement "le patient" ou "la patiente" pour garantir l'anonymat.
        2. Soit ultra professionnel, clinique et concis.
        
        Historique des séances :
        ${sessionsHistory}
        
        Tu DOIS répondre UNIQUEMENT avec un objet JSON valide ayant EXACTEMENT cette structure (sans aucun commentaire) :
        {
          "globalEvolutionSummary": "Synthèse narrative de l'évolution du patient sur l'ensemble des séances.",
          "positiveProgress": ["Progrès 1", "Progrès 2"],
          "remainingChallenges": ["Défi 1", "Défi 2"],
          "therapeuticAlliance": "Évaluation de l'alliance thérapeutique et de l'engagement du patient."
        }
      `;

      const response = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [
            { role: "system", content: "You are a helpful clinical assistant. Return ONLY valid JSON. Do not include markdown formatting." },
            { role: "user", content: prompt }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Perplexity API error:", errorText);
        return res.status(response.status).json({ error: "Failed to fetch from Perplexity API" });
      }

      const data = await response.json();
      let content = data.choices[0].message.content;
      
      content = content.replace(/\`\`\`json/g, "").replace(/\`\`\`/g, "").trim();

      res.json(JSON.parse(content));
    } catch (error) {
      console.error("Error in analyze-evolution:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
