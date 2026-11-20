import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Deletes test customers' orders and everything hanging off them. order_events, invoices and
 * credit notes are protected by triggers, so this turns triggers off for its own transaction
 * only (session_replication_role resets when it ends). That also turns off foreign keys, so
 * every child table is deleted explicitly. The order rows are locked first, so a background
 * job still working on one either finishes before this runs or finds the order gone.
 */
export async function deleteTestOrders(
  prisma: PrismaService,
  customerIds: string[],
): Promise<void> {
  if (customerIds.length === 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE customer_id = ANY(${customerIds}::uuid[]) ORDER BY id FOR UPDATE`;
    const orderIds = rows.map((r) => r.id);
    const invoiceIds = (
      await tx.invoice.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
    ).map((i) => i.id);
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await tx.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.discountRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
  });
}
