import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';

/**
 * Read-only catalog endpoints that feed the wizard's pickers. All are authenticated; the data is the
 * product master maintained in the reference tables.
 */
export const catalogRoutes = async (app: FastifyInstance): Promise<void> => {
  const auth = { preHandler: [app.authenticate] };

  app.get('/catalog/currencies', auth, () =>
    prisma.currency.findMany({ include: { exchangeRate: true }, orderBy: { code: 'asc' } }),
  );
  app.get('/catalog/clients', auth, () => prisma.client.findMany({ orderBy: { name: 'asc' } }));
  app.get('/catalog/locations', auth, () => prisma.location.findMany({ orderBy: { name: 'asc' } }));
  app.get('/catalog/settings', auth, () => prisma.setting.findMany({ orderBy: { key: 'asc' } }));

  app.get('/catalog/led-products', auth, () =>
    prisma.ledProduct.findMany({ orderBy: { model: 'asc' } }),
  );
  app.get('/catalog/controllers', auth, () => prisma.controller.findMany());
  app.get('/catalog/led-peripherals', auth, () => prisma.ledPeripheral.findMany());
  app.get('/catalog/mediaplayers', auth, () => prisma.mediaplayer.findMany());
  app.get('/catalog/peripherals', auth, () => prisma.peripheral.findMany());
  app.get('/catalog/gob-options', auth, () => prisma.gobOption.findMany());
  app.get('/catalog/frames', auth, () => prisma.frame.findMany());
  app.get('/catalog/trim-options', auth, () => prisma.trimOption.findMany());
  app.get('/catalog/hanging-bars', auth, () => prisma.hangingBarOption.findMany());
  app.get('/catalog/engineering-options', auth, () => prisma.engineeringOption.findMany());
  app.get('/catalog/install-methods', auth, () => prisma.installMethod.findMany());
  app.get('/catalog/access-equipment', auth, () => prisma.accessEquipment.findMany());
  app.get('/catalog/warranties', auth, () => prisma.warrantyOption.findMany());
  app.get('/catalog/service-hours', auth, () => prisma.serviceHoursOption.findMany());
  app.get('/catalog/freight-options', auth, () => prisma.freightOption.findMany());
  app.get('/catalog/screen-ratios', auth, () => prisma.screenRatio.findMany());
  app.get('/catalog/licence-components', auth, () => prisma.licenceComponent.findMany());
  app.get('/catalog/manufactured-products', auth, () => prisma.manufacturedProduct.findMany());
  app.get('/catalog/audio-products', auth, () => prisma.audioProduct.findMany());
  app.get('/catalog/music-services', auth, () => prisma.musicService.findMany());
  app.get('/catalog/hypervsn-products', auth, () => prisma.hypervsnProduct.findMany());

  // Display catalog is large; support a ?category= filter for the LCD step.
  app.get<{ Querystring: { category?: string } }>(
    '/catalog/display-catalog',
    auth,
    (request) =>
      prisma.displayCatalog.findMany({
        where: request.query.category ? { category: request.query.category } : undefined,
        orderBy: [{ category: 'asc' }, { model: 'asc' }],
      }),
  );
};
