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

## Jira en GitHub Actions
Cada ejecución crea un issue `Task` en el proyecto `SCRUM`. Cada job ejecutado
se registra como subtarea: pasa a `In Progress` al iniciar y a `Done` o `Failed`
al finalizar. El resultado y el enlace a los logs quedan en un comentario de la
subtarea; el issue padre se cierra según el resultado global del workflow.

Configura en **Settings → Secrets and variables → Actions** los secretos
`JIRA_EMAIL` (correo de la cuenta Jira) y `JIRA_API_TOKEN`. La cuenta necesita
permisos para crear y actualizar issues, agregar comentarios y ejecutar
transiciones en el proyecto. El URL de Jira y la clave del proyecto se definen
en el bloque `env` de `.github/workflows/pipeline.yml`. Los PRs
desde forks continúan sin Jira porque GitHub no expone secretos a esos eventos.
Usa una cuenta de servicio y un token limitados al proyecto; los workflows de PR
del mismo repositorio sí reciben los secretos configurados.

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
