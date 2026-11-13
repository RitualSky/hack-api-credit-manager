package com.ritualsky.creditmanager.resource;

import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.is;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

@QuarkusTest
class HelloResourceTest {

    @Test
    void helloDefaultsToWorld() {
        given().when().get("/api/v1/hello")
                .then().statusCode(200)
                .body("message", is("Hello Hack, World!"));
    }

    @Test
    void helloUsesNameParam() {
        given().queryParam("name", "Quarkus").when().get("/api/v1/hello")
                .then().statusCode(200)
                .body("message", is("Hello Hack, Quarkus!"));
    }
}
