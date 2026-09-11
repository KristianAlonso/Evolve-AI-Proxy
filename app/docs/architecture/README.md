# evolve_ai_proxy — Estructura Clean Architecture + N-Layer

## Arquitectura General

```
app/
├── src/
│   ├── domain/                    # Capa de Dominio (core business logic)
│   │   ├── entities/              # Entidades del dominio
│   │   ├── value-objects/         # Value Objects inmutables
│   │   ├── repositories/          # Interfaces de repositorios (contratos)
│   │   └── services/              # Servicios de dominio (lógica pura)
│   │
│   ├── application/               # Capa de Aplicación (use cases)
│   │   ├── usecases/              # Casos de uso (Interpret, Plan, Execute, Evaluate)
│   │   ├── dtos/                  # Data Transfer Objects
│   │   └── services/              # Servicios de aplicación (orquestación)
│   │
│   ├── infrastructure/            # Capa de Infraestructura (implementaciones)
│   │   ├── providers/             # Proveedores IA (ollama, anthropic, gemini, openai-compatible)
│   │   │   ├── base/              # Clase base abstracta para todos los proveedores
│   │   │   ├── ollama/            # Proveedor Ollama / LM Studio
│   │   │   ├── anthropic/         # Proveedor Anthropic (Claude)
│   │   │   ├── gemini/            # Proveedor Google Gemini
│   │   │   └── openai-compatible/ # Proveedores compatibles OpenAI API
│   │   ├── repositories/          # Implementaciones de repositorios
│   │   └── caching/               # Cache (Redis, memory)
│   │
│   ├── presentation/              # Capa de Presentación (API / HTTP)
│   │   ├── routes/                # Rutas Fastify (v1/chat/completions)
│   │   ├── controllers/           # Controladores que invocan use cases
│   │   └── middleware/            # Middleware (auth, rate-limit, logging)
│   │
│   ├── proxy/                     # Lógica central del proxy
│   │   ├── router/                # Router de requests a proveedores
│   │   ├── transformer/           # Transformador de inputs/outputs entre formatos
│   │   └── loop/                  # Bucle agéntico iterativo (Interpreter→Plan→Execute→Evaluate)
│   │
│   └── index.ts                   # Entry point — configura Fastify server
│
├── test/                          # Tests organizados por capa
│   ├── domain/                    # Tests unitarios de dominio
│   ├── application/               # Tests de use cases
│   ├── infrastructure/            # Tests de proveedores/repositorios
│   └── presentation/              # Tests de routes/controllers
│
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Flujo de Dependencias (Rule of Clean Architecture)

```
presentation → application ← infrastructure
                  ↓
                domain
```

- **Domain**: No depende de ninguna otra capa. Pura lógica de negocio.
- **Application**: Depende solo de `domain`. Define use cases y contratos.
- **Infrastructure**: Depende de `application` e `interface` para implementar contratos.
- **Presentation**: Depende de `application` para orquestar use cases.

## Reglas de Independencia

| Regla | Descripción |
|-------|-------------|
| **Dependency Rule** | Las dependencias apuntan hacia el centro (domain). El dominio no conoce nada del exterior. |
| **Interface Isolation** | Los contratos (repositorios, services) se definen en `domain` o `application`, las implementaciones en `infrastructure`. |
| **Use Case Driven** | Todo request HTTP termina invocando un use case específico en `application/usecases/`. |
| **Framework as Tool** | Fastify existe solo en la capa `presentation`. El dominio es framework-agnostic. |
