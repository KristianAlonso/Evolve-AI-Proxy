# A-002: Proveedores Soportados

**Estado:** Aceptada
**Fecha:** 2026-08-18
**Decisor(es):** Equipo evolve_ai_proxy

## Contexto

El proxy debe soportar múltiples proveedores de modelos de IA (LLMs) pero presentar una interfaz unificada al cliente. Esto permite que los consumidores del proxy no necesiten cambiar su código cuando cambian de proveedor, y facilita el testing comparativo entre diferentes modelos.

Se requiere definir qué proveedores se integran en la fase inicial y cómo se normaliza el formato de comunicación entre ellos.

## Decisiones

### Decisión Tomada

**Endpoint unificado `POST /v1/chat/completions` compatible con OpenAI API.** El proxy soporta las siguientes fuentes de modelos IA:

| Proveedor | Tipo | Notas |
| ----------- | ------ | ------- |
| Ollama / LM Studio | Local | Modelos locales, sin costo, offline. Endpoint compatible OpenAI |
| Proveedores compatibles OpenAI | Cloud/SaaS | Groq, Together AI, Mistral (vía endpoint OpenAI), etc. |
| Anthropic (Claude) | Cloud | API nativa de Anthropic, mapeada al formato unificado del proxy |
| Google Gemini | Cloud | API de Google AI / Vertex AI |

**Formato de salida:** Chat completions (text). Embeddings pendiente de definir.

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
| ------------- | ---------- | ------------- | --------------------- |
| **Endpoint por proveedor** (`/v1/openai/chat/completions`, `/anthropic/messages`, etc.) | Más directo, sin mapeo de formato | El cliente necesita múltiples endpoints y lógica de routing | Rompe la abstracción del proxy — el valor principal es justamente la unificación |
| **Solo OpenAI compatible** | Menor complejidad inicial | Limita los modelos disponibles a los que exponen endpoint OpenAI | Los mejores modelos actuales (Claude, Gemini) no tienen endpoint OpenAI nativo |
| **Transport protocol propio** (GraphQL, gRPC) | Tipado fuerte, eficiente | Requiere SDK/clientes específicos, pierde compatibilidad con la ecosistema existente de herramientas IA | El ecosistema de herramientas para Chat Completions es enorme; aprovecharlo reduce fricción |

## Consecuencias

### Positivas

- **Compatibilidad total** con cualquier cliente que soporte OpenAI API (LangChain, LlamaIndex, LM Studio UI, OpenWebUI, etc.)
- **Migración transparente** — cambiar de proveedor no requiere cambios en el código del cliente
- **Testing comparativo sencillo** — mismos inputs, diferentes backends
- **Barrera de entrada baja** — los desarrolladores ya conocen la API de OpenAI

### Negativas / Riesgos

- **Mapeo de formatos necesario** — cada proveedor tiene su propio formato de request/response que debe transformarse al estándar unificado y viceversa. Se implementará como una capa en `src/providers/`
- **Pérdida de features específicas** — algunas APIs tienen campos o funcionalidades no disponibles en el formato OpenAI (ej: system_fingerprint de Anthropic, tool_choice avanzado)
- **Embeddings pendiente** — la fase inicial solo cubre chat completions (text). Embeddings requerirán un endpoint adicional a definir.

## Referencias

- [AGENTS.md](../../../AGENTS.md) — Documento principal del proyecto
- [A-001: Lenguaje y Framework Principal](./a-001-lenguaje-y-framework-principal.md) — Node.js + Fastify como stack
