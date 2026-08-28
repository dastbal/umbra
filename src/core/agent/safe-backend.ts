import { FilesystemBackend } from 'deepagents';
import * as fs from 'fs';
import * as path from 'path';
import { agentPath } from '../config/agent-directory';

/**
 * 🛡️ SAFE BACKEND
 * * Extiende el backend de sistema de archivos nativo de DeepAgents para interceptar
 * operaciones destructivas (escritura/edición) y crear copias de seguridad automáticas.
 * * @example
 * ```ts
 * const backend = new SafeFilesystemBackend("/usuario/proyectos/mi-app");
 * // Ahora cada write_file o edit_file creará un backup en .umbra/backups
 * ```
 */
export class SafeFilesystemBackend extends FilesystemBackend {
  /** Directorio donde se almacenarán los backups */
  private backupDir: string;

  /** * Referencia local al directorio raíz para poder resolver rutas absolutas.
   * Fue necesario agregar esto porque la clase padre no expone `this.rootDir`.
   */
  private readonly rootDir: string;

  /**
   * Crea una instancia del backend seguro.
   * @param rootDir - La ruta absoluta del directorio de trabajo del agente.
   */
  constructor(rootDir: string) {
    // virtualMode: true asegura que el agente no pueda salir de rootDir (Sandbox)
    super({ rootDir, virtualMode: true });

    // 1. AQUI AGREGAMOS LA ASIGNACIÓN QUE FALTABA
    this.rootDir = rootDir;

    this.backupDir = agentPath(rootDir, 'backups');
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Sobrescribe la escritura nativa para inyectar el backup antes de modificar el archivo.
   * * @param filePath - Ruta relativa del archivo a escribir.
   * @param content - Nuevo contenido del archivo.
   * @returns El resultado de la operación de escritura original.
   */
  async write(filePath: string, content: string) {
    this.createBackup(filePath);
    return super.write(filePath, content);
  }

  /**
   * Sobrescribe la edición nativa para inyectar el backup antes de reemplazar texto.
   * * @param filePath - Ruta relativa del archivo.
   * @param oldString - Texto a buscar.
   * @param newString - Texto de reemplazo.
   * @param replaceAll - Si se deben reemplazar todas las ocurrencias.
   * @returns El resultado de la operación de edición original.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ) {
    this.createBackup(filePath);
    return super.edit(filePath, oldString, newString, replaceAll);
  }

  /**
   * Genera una copia del archivo original con timestamp antes de ser modificado.
   * Si el archivo no existe (es nuevo), no hace nada.
   * * @param virtualPath - Ruta virtual (desde el punto de vista del agente) del archivo.
   */
  private createBackup(virtualPath: string) {
    try {
      // Convertir ruta virtual (/src/...) a ruta real del sistema
      const relativePath = virtualPath.startsWith('/')
        ? virtualPath.slice(1)
        : virtualPath;

      // 2. AQUI AHORA FUNCIONA PORQUE YA DEFINIMOS this.rootDir
      const realPath = path.join(this.rootDir, relativePath);

      if (fs.existsSync(realPath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.basename(realPath);
        const backupPath = path.join(
          this.backupDir,
          `${timestamp}_${filename}.bak`,
        );

        fs.copyFileSync(realPath, backupPath);
        console.log(
          `💾 [SafeBackend] Backup creado: .umbra/backups/${path.basename(backupPath)}`,
        );
      }
    } catch (error) {
      console.error(
        `⚠️ [SafeBackend] Falló el backup (continuando escritura):`,
        error,
      );
    }
  }
}
