package com.ritualsky.creditmanager.resource;

import com.ritualsky.creditmanager.dto.HelloResponse;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;

@Path("/api/v1/hello")
@Produces(MediaType.APPLICATION_JSON)
public class HelloResource {

    @GET
    public HelloResponse hello(@QueryParam("name") String name) {
        String target = (name == null || name.isBlank()) ? "World" : name.trim();
        return new HelloResponse("Hello, " + target + "!");
    }
}
