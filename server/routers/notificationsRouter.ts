import { z } from "zod";
import { router, selfServiceProcedure } from "../trpc";
import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/appNotificationService";

export const notificationsRouter = router({
  list: selfServiceProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(40),
          unreadOnly: z.boolean().optional(),
          requiresActionOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listUserNotifications(ctx.user.id, input?.limit ?? 40, {
        unreadOnly: input?.unreadOnly === true,
        requiresActionOnly: input?.requiresActionOnly === true,
      }),
    ),

  markRead: selfServiceProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => markNotificationRead(ctx.user.id, input.id)),

  markAllRead: selfServiceProcedure.mutation(({ ctx }) =>
    markAllNotificationsRead(ctx.user.id),
  ),
});
