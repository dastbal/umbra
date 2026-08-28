# Interaction Module (Agent UI)

Este módulo se encarga de gestionar de forma centralizada y escalable toda la comunicación hacia la terminal para el agente inteligente. Utiliza **Domain-Driven Design (DDD)** para desacoplar las reglas de negocio de librerías de infraestructura como `chalk` y `ora`.

## Estructura del Módulo

- \`domain/\`: Define los contratos (puertos) para logs y spinners (`LoggerPort`, `SpinnerPort`).
- \`infrastructure/\`: Implementaciones reales (`ChalkLoggerAdapter`, `OraSpinnerAdapter`).
- \`application/\`: El servicio orquestador (`InteractionService`).

## Uso Básico

Puedes inyectar o instanciar el \`InteractionService\` y utilizar sus métodos para dar retroalimentación elegante al usuario.

\`\`\`typescript
import { InteractionService } from '../interaction';

const interaction = new InteractionService();

// Mensajes de log simples y estilizados
interaction.logInfo('Iniciando proceso...');
interaction.logSuccess('Directorio creado con éxito');
interaction.logWarning('El archivo ya existe, sobrescribiendo...');
interaction.logError('La conexión a la base de datos falló');
interaction.logDebug('Trazas extra...');

// Manejo de Tareas con Spinners
const task = interaction.startTask('Sincronizando la base de conocimientos...');

try {
  await syncKnowledgeBase();
  task.succeed('Base de conocimientos sincronizada.');
} catch (err) {
  task.fail('Error sincronizando los datos.');
}
\`\`\`

## Integración en NestJS

Si ejecutas el agente dentro del ecosistema de NestJS, el servicio está exportado por el \`AiAgentModule\` y marcado como \`@Injectable()\`:

\`\`\`typescript
import { Injectable } from '@nestjs/common';
import { InteractionService } from '@dastbal/umbra/core/interaction';

@Injectable()
export class MyFeatureService {
  constructor(private readonly interaction: InteractionService) {}

  execute() {
    this.interaction.logInfo('Ejecutando feature...');
  }
}
\`\`\`

## Escalabilidad

Al seguir patrones de arquitectura hexagonal / puertos y adaptadores:
- Cambiar \`ora\` por otra librería de spinners nativa es trivial: solo crea un nuevo adaptador que implemente \`SpinnerPort\`.
- Redirigir la salida (ej., a un WebSocket o un dashboard web) se hace modificando el \`InteractionService\` sin afectar a los consumidores como el \`GraphFactory\`.
