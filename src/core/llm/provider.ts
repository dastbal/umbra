import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// 1. Cargar variables de entorno desde la RAÍZ del proyecto
// process.cwd() obtiene la carpeta desde donde ejecutas "npm run agent"
const rootDir = process.cwd();
dotenv.config({ path: path.join(rootDir, '.env.development') });

export class LLMProvider {
  private static instance: ChatVertexAI;

  private constructor() {}

  // Allow dynamic models for Multi-Agent supervisor pattern
  public static createModel(config?: { modelName?: string, temperature?: number }): ChatVertexAI {
    this.ensureCredentials();
    return new ChatVertexAI({
      model: config?.modelName || process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-2.0-flash-lite-001',
      temperature: config?.temperature ?? 0,
    });
  }

  private static ensureCredentials() {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentialsPath) throw new Error('❌ GOOGLE_APPLICATION_CREDENTIALS no está definido en el .env');
    const absoluteCredentialsPath = path.resolve(rootDir, credentialsPath);
    if (!fs.existsSync(absoluteCredentialsPath)) throw new Error(`❌ No se encuentra el archivo de credenciales en: ${absoluteCredentialsPath}`);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = absoluteCredentialsPath;
  }

  public static getModel(): ChatVertexAI {
    if (!this.instance) {
      this.ensureCredentials();

      this.instance = new ChatVertexAI({
        model: process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-2.0-flash-lite-001',
        temperature: 0,
      });
    }
    return this.instance;
  }

  private static embeddingsInstance: VertexAIEmbeddings;

  public static getEmbeddingsModel(): VertexAIEmbeddings {
    if (!this.embeddingsInstance) {
      // Validar credentials igual que antes...

      this.embeddingsInstance = new VertexAIEmbeddings({
        model: 'text-embedding-004', // El modelo más eficiente de Google actualmente
        // Los mismos parámetros de location y projectID que ya configuramos
      });
    }
    return this.embeddingsInstance;
  }
}
