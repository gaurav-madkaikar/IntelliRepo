package demo

fun orderRoutes() {
  routing {
    route("/api") {
      authenticate("jwt") {
        get("/orders/{id}") { }
      }
    }
  }
}
