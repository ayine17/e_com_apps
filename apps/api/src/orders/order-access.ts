import { NotFoundException } from "@nestjs/common";
import { User } from "@prisma/client";
import { isStaff } from "../common/auth";
import { PrismaService } from "../core/prisma.service";

export type OrderRole = "buyer" | "seller" | "staff";

/**
 * Loads an order only if the user is part of it. Returns 404 (not 403) otherwise, so order
 * ids can't be probed. Spec section 8.2: ownership is checked on every request.
 */
export async function loadOrderFor(prisma: PrismaService, user: User, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { store: true } });
  if (!order) throw new NotFoundException("Order not found");
  let role: OrderRole | null = null;
  if (order.buyerId === user.id) role = "buyer";
  else if (order.store.ownerId === user.id) role = "seller";
  else if (isStaff(user)) role = "staff";
  if (!role) throw new NotFoundException("Order not found");
  return { order, role };
}
