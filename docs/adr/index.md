# Architecture Decision Records — evolve_ai_proxy

Registro de decisiones arquitecturales que han dado forma al diseño y la evolución del sistema.

## Decisiones Registradas

| ID | Título | Estado | Descripción |
|----|--------|--------|-------------|
| [A-001](./a-001-lenguaje-y-framework-principal.md) | Lenguaje y Framework Principal | **Aceptada** | Node.js + Fastify como stack principal por rendimiento, validación nativa y hooks del lifecycle. |
| [A-002](./a-002-proveedores-soportados.md) | Proveedores Soportados | **Aceptada** | Endpoint unificado `POST /v1/chat/completions` compatible con OpenAI API para Ollama, Anthropic y Google Gemini. |
| [A-003](./a-003-patron-agentico-iterativo.md) | Patrón Agéntico Iterativo | **Aceptada** | Sistema de interpretación → planificación → ejecución → evaluación en bucle controlado para resolver solicitudes complejas. |

## Formato de los ADRs

Cada Architecture Decision Record sigue esta estructura:

```markdown
# A-XXX: [Título]

**Estado:** [Propuesta | Aceptada | Rechazada | Superseded | Obsoleta]
**Fecha:** YYYY-MM-DD
**Decisor(es):** [Equipo / Persona]

## Contexto

[Descripción del problema o situación que motiva la decisión.]

## Decisiones

### Decisión Tomada

[Qué se decidió y por qué.]

### Alternativas Consideradas

| Alternativa | Ventajas | Desventajas | Por qué no se eligió |
|-------------|----------|-------------|---------------------|
| Opción A | ... | ... | ... |
| Opción B | ... | ... | ... |

## Consecuencias

### Positivas

- [Efectos beneficiosos de la decisión]

### Negativas / Riesgos

- [Costos, compensaciones o riesgos asociados]

## Referencias

- [Enlaces a documentación relacionada, otros ADRs, etc.]
```

## Estados de un ADR

| Estado | Significado |
| -------- | ------------- |
| **Propuesta** | Decisión sugerida, en revisión. No implementada aún. |
| **Aceptada** | Decisión aprobada y vigente. Base del diseño actual. |
| **Rechazada** | Alternativa considerada pero descartada. |
| **Superseded** | Reemplazada por un ADR posterior (ej: A-001 → A-010). |
| **Obsoleta** | Ya no aplica al proyecto actual. |

## Cómo Contribuir

Cuando se tome una decisión arquitectural significativa:

1. Crear nuevo archivo `docs/adr/a-XXX-[titulo-en-kebab-case].md`
2. Numeración secuencial (A-003, A-004, ...)
3. Actualizar este índice con la nueva entrada en la tabla
4. Referenciar el ADR desde `AGENTS.md` si aplica

## Principios Rectores

Estos principios se mencionan frecuentemente en los ADRs y guían las decisiones:

1. **Validación primero** — Todo request debe validarse contra un schema JSON antes de procesarse
2. **Minimalismo** — No añadir dependencias sin justificar el valor real que aportan
3. **Documentar todo** — Decisiones importantes se registran como ADRs
