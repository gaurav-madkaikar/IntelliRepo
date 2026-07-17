package demo;

class NotificationRoutes {
  void configure(Router router) {
    router.post("/notifications").handler(this::authenticate).handler(this::createNotification);
  }

  void authenticate(RoutingContext context) {}

  void createNotification(RoutingContext context) {}
}
