/**
 * Response bodies modelled on Shiprocket's documented GET /courier/serviceability/ format
 * (trimmed to the fields we read, plus a few we ignore). NOT recorded from the live API:
 * replace with recorded responses once the Shiprocket account exists.
 */

export const serviceableBody = {
  status: 200,
  currency: 'INR',
  data: {
    recommended_courier_company_id: 10,
    available_courier_companies: [
      {
        courier_company_id: 10,
        courier_name: 'Courier A Surface',
        estimated_delivery_days: '5',
        etd: 'Nov 25, 2026',
        cod: 0,
        blocked: 0,
        rate: 56,
        city: 'Mumbai',
        state: 'Maharashtra',
        postcode: '400001',
      },
      {
        courier_company_id: 24,
        courier_name: 'Courier B Air',
        estimated_delivery_days: 3, // sometimes a number
        cod: 1,
        blocked: 0,
        rate: 89,
        city: 'Mumbai',
        state: 'Maharashtra',
      },
      {
        courier_company_id: 31,
        courier_name: 'Blocked courier',
        estimated_delivery_days: '1',
        cod: 1,
        blocked: 1, // must be ignored
      },
    ],
  },
};

export const noCodBody = {
  status: 200,
  data: {
    available_courier_companies: [
      {
        courier_name: 'Courier A',
        estimated_delivery_days: '7',
        cod: 0,
        city: 'Shillong',
        state: 'Meghalaya',
      },
      { courier_name: 'Courier B', estimated_delivery_days: '9', cod: '0' },
    ],
  },
};

export const notServiceableBody = {
  status: 404,
  message: 'Delivery postcode not serviceable',
};

export const emptyCouriersBody = { status: 200, data: { available_courier_companies: [] } };

export const loginBody = { id: 1, email: 'api@example.com', token: 'tok-123' };
