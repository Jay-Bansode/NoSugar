# API modules

One folder per domain module (CLAUDE.md §4). Each module has `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/` and `*.spec.ts`. Business logic goes in services, never in controllers.

| Module                           | Phase | Status                   |
| -------------------------------- | ----- | ------------------------ |
| `health`                         | 0     | done                     |
| `auth`                           | 1     | done                     |
| `catalog`                        | 1     | done                     |
| `pricing`                        | 1     | done                     |
| `cart`                           | 1     | done                     |
| `checkout`                       | 1     | done                     |
| `orders`                         | 1     | done                     |
| `payments`                       | 1     | done                     |
| `invoicing`                      | 1     | done                     |
| `admin`                          | 2     | started (auth, audit)    |
| `content`                        | 2     | planned                  |
| `reviews`                        | 2     | planned                  |
| `fulfilment`                     | 1, 3  | started (serviceability) |
| `wallet` (includes trial claims) | 3     | planned                  |
| `notifications`                  | 3     | planned                  |
| `webhooks`                       | 1–3   | started (Razorpay)       |
