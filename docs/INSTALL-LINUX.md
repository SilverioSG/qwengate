# QwenGate — instalación Linux

Instalación reproducible de la rama `native-local-mcp`.

## Base funcional validada

La implementación Native MCP fue validada desde un clon limpio en otra máquina Linux.

Base funcional:

```text
1556912f938cc0f006303c84fa1fd7a9b84d27cf
```

El instalador acepta commits posteriores siempre que contengan esta base como ancestro.

## Instalación rápida

```bash
git clone -b native-local-mcp \
  https://github.com/SilverioSG/qwengate.git

cd qwengate

./scripts/install-linux.sh
```

El script:

1. comprueba prerequisitos;
2. instala Bun si falta;
3. valida la rama;
4. instala dependencias;
5. ejecuta tests, typecheck, lint y build;
6. fija `HOST=127.0.0.1`;
7. instala el servicio systemd;
8. habilita y arranca QwenGate;
9. valida `/health` y `/v1/models`;
10. muestra la URL del dashboard.

## Login de cuentas

El único paso manual es abrir:

```text
http://127.0.0.1:26405/dashboard/accounts
```

Usar `Login / Add Account` y autenticar las cuentas Qwen desde el navegador.

No es necesario copiar tokens, `accounts.json` ni browser profiles desde otra máquina.

## API

```text
http://127.0.0.1:26405/v1
```

## Modelos principales

```text
qwen3.8-max
qwen3.7-plus
```

## OpenCode

QwenGate funciona como provider OpenAI-compatible estándar.

Configuración:

```text
provider id: qwen-gate
provider type: @ai-sdk/openai-compatible
baseURL: http://127.0.0.1:26405/v1
models:
  qwen3.8-max
  qwen3.7-plus
```

No requiere XML, MCP especial ni adaptación de herramientas en OpenCode.

OpenCode envía `tools[]` estándar y QwenGate realiza internamente la traducción Native MCP.

Después de modificar la configuración de OpenCode hay que reiniciar OpenCode para cargar el provider.

## Smoke test agentic

Desde OpenCode:

```text
Ejecuta pwd y responde únicamente con la ruta actual.
```

Flujo esperado:

```text
OpenCode tools[]
→ QwenGate
→ Native local_mcp
→ tool_call estructurado
→ ejecución real
→ tool_result
→ continuación
→ respuesta final
```

No deben aparecer:

```text
XML
fake tool results
duplicated tool calls
post-tool garbage
loops
```

## Servicio

Estado:

```bash
systemctl status qwen-gate.service
```

Restart:

```bash
sudo systemctl restart qwen-gate.service
```

Logs:

```bash
journalctl -u qwen-gate.service -f
```

Health:

```bash
curl -sS http://127.0.0.1:26405/health | jq
```

Modelos:

```bash
curl -sS http://127.0.0.1:26405/v1/models | jq
```

## Actualización

No sobrescribir:

```text
.qwen/accounts.json
.qwen/browser-profiles/
```

Actualizar código siguiendo la rama correspondiente y volver a validar build/tests antes de reiniciar el servicio.

## Desinstalar servicio

```bash
sudo systemctl disable --now qwen-gate.service
sudo rm /etc/systemd/system/qwen-gate.service
sudo systemctl daemon-reload
```

Esto no elimina el repositorio ni las cuentas.
