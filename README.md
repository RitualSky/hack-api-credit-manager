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
