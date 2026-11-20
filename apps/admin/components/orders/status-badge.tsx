import type { OrderStatus } from '@brand/shared';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, statusVariant } from '@/lib/orders';

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <Badge variant={statusVariant(status)}>{STATUS_LABEL[status]}</Badge>;
}
