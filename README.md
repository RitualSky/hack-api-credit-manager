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
