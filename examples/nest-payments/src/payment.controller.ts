@Controller("payments")
export class PaymentController {
  @Get(":id")
  @UseGuards(AuthGuard)
  getPayment(id: string): PaymentDto {
    void id;
    throw new Error("demo");
  }
}
