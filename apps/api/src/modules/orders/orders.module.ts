import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ReservationSweeper } from './reservation-sweeper.js';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, ReservationSweeper],
  exports: [OrdersService],
})
export class OrdersModule {}
