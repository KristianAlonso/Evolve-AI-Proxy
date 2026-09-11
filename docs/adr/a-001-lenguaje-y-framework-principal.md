# A-001: Lenguaje y Framework Principal

**Estado:** Aceptada
**Fecha:** 2026-08-18
**Decisor(es):** Equipo evolve_ai_proxy

## Contexto

Se debe elegir el lenguaje de programación y framework web para construir el proxy de IA. El sistema necesita manejar requests HTTP de alto rendimiento, ya que cada solicitud pasa por múltiples saltos (cliente → proxy → proveedor IA). La latencia introducida por el proxy debe ser mínima.

Además, como el proxy transforma inputs/outputs entre diferentes formatos de proveedores de IA, se requiere validación estricta y estructurada de los datos en cada paso del pipeline.

## Decisiones

### Decisión Tomada

**Node.js + Fastify con TypeScript.**

| Criterio | Justificación |
| ---------- | --------------- |
| **Rendimiento** | Fastify es ~3x más rápido que Express, crítico porque cada request pasa por múltiples hops (cliente → proxy → proveedor IA) |
| **Validación nativa** | JSON Schema integrado — validamos requests/responses sin plugins externos, esencial para un proxy que transforma inputs |
| **Hooks del lifecycle** | `onRequest`, `preParsing`, `preValidation`, `onError` permiten logging, auth checks y transformación en puntos controlados |
| **TypeScript** | Soporte nativo con `@fastify/typebox-type-provider` — tipado estricto desde el día 1 |
| **Ecosistema npm** | Amplio pero selectivo — usaremos solo lo que añada valor real, sin dependencias innecesarias |

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
| ------------- | ---------- | ------------- | --------------------- |
| **Express.js** | Ecosistema más maduro, comunidad grande | ~3x más lento que Fastify, validación requiere plugins externos (Joi, Joi) | Rendimiento inferior para un caso de uso sensible a latencia |
| **NestJS** | Arquitectura enterprise, TypeScript nativo, DI pattern | Overhead significativo por su complejidad, startup más lento, opaco para un proyecto en fase inicial | Demasiado pesado para un proxy que debe ser minimalista y rápido |
| **Go** | Compilado, extremadamente rápido, bajo consumo de memoria | Curva de aprendizaje para el equipo actual, desarrollo más lento inicialmente, menos flexibilidad para prototipado rápido | El stack Node.js ya está definido; Go puede evaluarse en una futura reescritura si el rendimiento lo justifica |
| **Rust + Actix** | Máximo rendimiento posible | Curva de aprendizaje pronunciada, ecosistema más pequeño para integraciones específicas con IA | Overkill para la fase actual del proyecto |

## Consecuencias

### Positivas

- Rendimiento óptimo para el caso de uso (latencia mínima por hop)
- Validación de schemas nativa sin dependencias adicionales
- Hooks del lifecycle permiten implementar logging, auth y transformación en puntos precisos
- TypeScript nativo con TypeBox proporciona tipado fuerte en toda la base de código
- Ecosistema npm permite integrar proveedores rápidamente

### Negativas / Riesgos

- Node.js es single-threaded — para cargas extremadamente concurrentes podría requerir clustering
- La validación JSON Schema tiene overhead computacional (mitigable con caching de schemas)
- Menor tipado estructural comparado con Go/Rust en tiempo de compilación

## Referencias

- [AGENTS.md](../../../AGENTS.md) — Documento principal del proyecto
- [A-002: Proveedores Soportados](./a-002-proveedores-soportados.md) — Diseño del endpoint unificado
