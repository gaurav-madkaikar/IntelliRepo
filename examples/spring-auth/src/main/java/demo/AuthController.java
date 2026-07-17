package demo;

@RequestMapping("/api/auth")
@RestController
public class AuthController {
  @PostMapping("/login")
  @PreAuthorize("isAnonymous()")
  public TokenResponse login(@RequestBody LoginRequest request) {
    return null;
  }
}
