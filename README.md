# hack-api-credit-manager

Plantilla base de API con Quarkus 3.15 (LTS) y Java 21.

## Requisitos
- JDK 21
- Maven 3.9+

## Comandos
```
mvn quarkus:dev      # modo desarrollo (hot reload)
mvn test             # tests
mvn package          # genera target/quarkus-app/quarkus-run.jar
java -jar target/quarkus-app/quarkus-run.jar
```

## SonarCloud
El job de SonarCloud requiere el secreto de Actions `SONAR_TOKEN`, con permiso
para analizar el proyecto. Por defecto utiliza la organización `ritualsky` y la
clave de proyecto `RitualSky_hack-api-credit-manager`. El proyecto debe existir
en SonarCloud; si sus identificadores son distintos, configura las variables de
Actions `SONAR_ORGANIZATION` y `SONAR_PROJECT_KEY` para sobrescribir estos valores.
El análisis mantiene la validación del quality gate.

## Snyk SCA
El job `Snyk Security Check` analiza las dependencias Maven y npm, incluidas las
de desarrollo, y bloquea el avance si detecta vulnerabilidades altas o críticas
o si no puede completar el análisis. Configura el secreto de Actions `SNYK_TOKEN`
con un token de tu cuenta Snyk. El reporte JSON se publica en el artefacto
`snyk-sca-reports` de la ejecución. Los PRs desde forks omiten este job porque
GitHub no expone secretos a esos eventos.

## Jira en GitHub Actions
Cada ejecución crea un issue `Tarea` en el proyecto `SCRUM`. Cada job ejecutado
se registra como subtarea: pasa a `En curso` al iniciar y a `Finalizado` o
`Fallido` al terminar. La descripción y un comentario de cada subtarea incluyen
el resultado y el enlace a los logs y artefactos. En los PRs, un comentario
vincula el issue padre y registra el resultado de cada etapa; al final agrega un
resumen del workflow.

Configura en **Settings → Secrets and variables → Actions** los secretos
`JIRA_EMAIL` (correo de la cuenta Jira) y `JIRA_API_TOKEN`. La cuenta necesita
permisos para crear y actualizar issues, agregar comentarios y ejecutar
transiciones en el proyecto. El URL de Jira y la clave del proyecto se definen
en `.github/scripts/jira.js` y en el bloque `env` de `.github/workflows/pipeline.yml`,
respectivamente. Los PRs
desde forks continúan sin Jira porque GitHub no expone secretos a esos eventos.
Usa una cuenta de servicio y un token limitados al proyecto; los workflows de PR
del mismo repositorio sí reciben los secretos configurados.

Para ejecutar los tests del cliente Jira y generar cobertura LCOV:
```
npm ci
npm run test:jira
```
El comando exige 100% de cobertura en líneas, funciones y ramas. El pipeline
entrega `coverage/lcov.info` a SonarCloud.

## Pruebas de performance (k6)
El job `performance` ejecuta [tests/performance/load.js](tests/performance/load.js)
contra `CERT_URL` (o, si no está definido, contra la API levantada en el runner):
carga corta (30 s, hasta 5 usuarios virtuales) sobre
`GET /api/v1/hello` con umbrales de errores < 1 % y p95 < 800 ms. El resumen se
publica como artefacto `k6-summary`. Para correrlo en local:
```
k6 run -e BASE_URL=http://localhost:8080 tests/performance/load.js
```

## Endpoints
| Ruta | Descripción |
|------|-------------|
| `GET /api/v1/hello?name=Ana` | Endpoint de ejemplo |
| `GET /q/health` | Health checks |
| `GET /openapi` | Especificación OpenAPI |
| `GET /swagger-ui` | Swagger UI |

## Estructura
```
src/main/java/com/ritualsky/creditmanager/
  resource/   # endpoints REST
  dto/        # objetos de request/response
```
