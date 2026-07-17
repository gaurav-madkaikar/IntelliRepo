function authMiddleware(): void {}
function getUserById(): void {}

const app = express();
const router = Router();
app.use("/api", router);
router.get("/users/:id", authMiddleware, getUserById);
