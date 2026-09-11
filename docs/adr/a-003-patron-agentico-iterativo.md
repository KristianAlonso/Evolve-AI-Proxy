# A-003: Patrón Agéntico Iterativo

**Estado:** Aceptada
**Fecha:** 2026-08-18
**Decisor(es):** Equipo evolve_ai_proxy

## Contexto

El objetivo principal de `evolve_ai_proxy` no es simplemente reenviar requests a modelos de IA, sino actuar como un **sistema agéntico** que:

1. Recibe una solicitud del usuario
2. Solicita al modelo de IA que **interprete y comprenda en profundidad** la petición
3. Genera una tarea ejecutable basada en esa interpretación
4. Ejecuta la tarea y obtiene el resultado
5. A partir del resultado, genera una nueva tarea
6. Repite los pasos 4-5 iterativamente hasta cumplir completamente con la solicitud original

Este patrón es inspirado por frameworks como AutoGPT, BabyAGI y LangChain's AgentExecutor, pero adaptado para operar bajo demanda de modelos locales pequeños y compatibles con API OpenAI.

El desafío arquitectónico principal es diseñar un bucle controlado que gestione estas iteraciones sin perder el contexto original, sin entrar en loops infinitos, y manteniendo la trazabilidad completa del proceso.

## Decisiones

### Decisión Tomada

**Patrón "Interpret-Plan-Execute-Iterate" con límite de rondas.** El proxy implementa un bucle agéntico donde cada iteración sigue estas fases:

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ Interpretar │───>│   Planificar  │───>│   Ejecutar    │
│ (entender)  │    │ (generar     │    │ (ejecutar     │
│             │    │    tarea(s))  │    │    tarea(s))  │
└──────┬──────┘    └──────┬───────┘    └──────┬────────┘
       │                   │                   │
       │           ┌───────▼───────┐    ┌──────▼───────┐
       └──────────<│   Evaluar     │◄───│  Recopilar   │
                   │ (¿cumplido?)  │    │  resultado   │
                   └───────┬───────┘    └──────────────┘
                           │
                    Cumplido?
                     /        \
              No ◄─────────► Sí
               │                  │
               ▼                  ▼
       Generar       Devolver resultado final
       siguiente     al cliente con resumen
       tarea         del proceso completo
```

| Componente | Descripción | Ubicación propuesta |
|------------|-------------|-------------------|
| **Interpreter** | Analiza la solicitud original y el contexto acumulado para determinar qué se necesita hacer | `src/proxy/interpreter.ts` |
| **Planner** | Genera una o más tareas ejecutables basadas en la interpretación. Cada tarea tiene ID, descripción, dependencias y formato esperado de resultado | `src/proxy/planner.ts` |
| **Executor** | Ejecuta cada tarea llamando al modelo IA correspondiente (según A-002) con el prompt específico de la tarea | `src/proxy/executor.ts` |
| **Evaluator** | Compara el resultado acumulado contra el objetivo original. Decide si se ha cumplido o si se necesita otra iteración | `src/proxy/evaluator.ts` |
| **Loop Controller** | Coordina las fases, gestiona el límite máximo de rondas (configurable), y mantiene el historial de contexto | `src/proxy/agent_loop.ts` |

### Parámetros de control del bucle:

| Parámetro | Valor por defecto | Descripción |
|-----------|------------------|-------------|
| `max_iterations` | 10 | Número máximo de iteraciones antes de forzar una respuesta final |
| `context_window_size` | 4 | Solo los últimos N resultados se incluyen en el contexto (para evitar overflow) |
| `timeout_ms` | 60000 | Tiempo máximo por iteración completa |
| `stop_threshold` | null | Umbral de similitud semántica entre iteraciones consecutivas para detectar loops |

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| **Bucle infinito sin límite** | Máxima flexibilidad, nunca corta prematuramente | Riesgo de loops infinitos si el modelo no converge. Consumo descontrolado de tokens/costo. | Demasiado peligroso para producción. Siempre debe haber un mecanismo de seguridad. |
| **Single-pass (sin iteración)** | Simple, predecible, bajo costo | No cumple con la propuesta original del proyecto. No puede resolver tareas complejas que requieran descomposición. | Contradice el propósito fundamental de "Evolve" proxy AI. |
| **Pipeline predefinido** | Determinista, fácil de debuggear | Inflexible, no se adapta a solicitudes inesperadas. Requiere mantenimiento manual. | Pierde la adaptabilidad del agente. Mejor un patrón genérico que pipelines hardcodeados. |
| **Sub-agentes paralelos** | Mayor throughput para tareas independientes | Complejidad exponencial en coordinación y fusión de resultados. Overhead significativo. | Demasiado complejo para fase inicial. Se puede explorar como optimización futura (A-XXX). |

## Consecuencias

### Positivas

- **Resolución autónoma de problemas complejos** — El sistema descompone tareas grandes en subtareas ejecutables
- **Adaptabilidad total** — No necesita conocer de antemano qué tipo de solicitud recibirá
- **Trazabilidad completa** — Cada iteración queda registrada con su interpretación, tarea generada y resultado
- **Seguridad por diseño** — Límite máximo de iteraciones previene loops infinitos
- **Contexto controlado** — El contexto se limita a las N últimas iteraciones para evitar overflow del modelo

### Negativas / Riesgos

- **Latencia acumulativa** — Cada iteración añade tiempo de respuesta. Una solicitud que requiera 5 iteraciones tomará ~5x más que una single-pass
- **Costo en tokens** — Si se usan modelos cloud, cada iteración consume tokens adicionales (interpretar + planificar + evaluar)
- **Qualidad dependiente del modelo** — Modelos pequeños pueden no converger bien o entrar en bucles sin sentido. Se necesita un buen evaluator y límites estrictos
- **Complejidad de debugging** — Un agente que itera 10 veces genera un historial largo difícil de rastrear si algo falla

### Mitigaciones propuestas

| Riesgo | Mitigación |
|--------|-----------|
| Latencia acumulativa | Implementar streaming parcial: enviar resultados intermedios al cliente a medida que se generan (Server-Sent Events) |
| Costo en tokens | Permitir al usuario configurar `max_iterations` y `context_window_size` por request. Mostrar estimación de costo antes de iniciar |
| Modelos pequeños no convergentes | Implementar detección de loops: si 2 iteraciones consecutivas son >90% similares, forzar parada con warning |
| Complejidad de debugging | Registrar cada iteración como un objeto estructurado `{iteration, interpretation, plan, execution, result}` que se devuelve al cliente junto con la respuesta final |

## Referencias

- [AGENTS.md](../../../AGENTS.md) — Documento principal del proyecto
- [A-001: Lenguaje y Framework Principal](./a-001-lenguaje-y-framework-principal.md) — Node.js + Fastify como stack
- [A-002: Proveedores Soportados](./a-002-proveedores-soportados.md) — Endpoint unificado para proveedores de IA
