# API modules

One folder per domain module (CLAUDE.md Â§4). Each module has `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/` and `*.spec.ts`. Business logic goes in services, never in controllers.

| Module                           | Phase | Status                   |
| -------------------------------- | ----- | ------------------------ |
| `health`                         | 0     | done                     |
| `auth`                           | 1     | done                     |
| `catalog`                        | 1     | done                     |
| `pricing`                        | 1     | done                     |
| `cart`                           | 1     | done                     |
| `checkout`                       | 1     | planned                  |
| `orders`                         | 1     | planned                  |
| `payments`                       | 1     | planned                  |
| `invoicing`                      | 1     | planned                  |
| `admin`                          | 2     | planned                  |
| `content`                        | 2     | planned                  |
| `reviews`                        | 2     | planned                  |
| `fulfilment`                     | 1, 3  | started (serviceability) |
| `wallet` (includes trial claims) | 3     | planned                  |
| `notifications`                  | 3     | planned                  |
| `webhooks`                       | 1â€“3 | planned                  |
