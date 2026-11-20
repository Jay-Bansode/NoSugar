/**
 * Development seed: the initial catalog (CLAUDE.md §1) and default settings.
 * Run: pnpm --filter @brand/api db:seed   (idempotent; never overwrites existing rows)
 *
 * ⚠ PLACEHOLDERS, not for production:
 *   - flavour names come from the reference site; final names/copy are TBD
 *   - every price except the ₹399 trial kit
 *   - HSN codes and GST rates: confirm with the CA (CLAUDE.md §11). The trial kit is a
 *     mixed supply (coffee + tumbler), usually taxed at the highest rate of its parts.
 */
import { DEFAULT_SETTINGS, type SettingKey } from '@brand/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const COFFEE_HSN = '2101'; // PLACEHOLDER: coffee extracts/preparations
const COFFEE_GST_BPS = 500; // PLACEHOLDER: 5%
const TUMBLER_HSN = '9617'; // PLACEHOLDER: vacuum flasks
const TUMBLER_GST_BPS = 1800; // PLACEHOLDER: 18%
const DEV_STOCK = 100;

const FLAVOURS = [
  { slug: 'hazel-almond-latte', name: 'Hazel Almond Latte', code: 'HAZ' },
  { slug: 'silk-chocolate-mocha', name: 'Silk Chocolate Mocha', code: 'MOC' },
  { slug: 'sea-salt-caramel', name: 'Sea Salt Caramel', code: 'CAR' },
  { slug: 'french-vanilla-cloud', name: 'French Vanilla Cloud', code: 'VAN' },
  { slug: 'butter-gooey-toffee', name: 'Butter Gooey Toffee', code: 'TOF' },
] as const;

const PACKS = [
  { size: 6, mrpPaise: 34900, pricePaise: 29900, weightG: 150 }, // PLACEHOLDER prices
  { size: 15, mrpPaise: 79900, pricePaise: 69900, weightG: 330 }, // PLACEHOLDER prices
] as const;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required to seed');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function seedSettings(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS) as [SettingKey, unknown][]) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy: 'seed' },
      update: {}, // keep values changed in admin
    });
  }
}

async function seedCoffee(): Promise<{ sixPacks: string[]; fifteenPacks: string[] }> {
  const sixPacks: string[] = [];
  const fifteenPacks: string[] = [];

  for (const flavour of FLAVOURS) {
    const product = await prisma.product.upsert({
      where: { slug: flavour.slug },
      create: {
        slug: flavour.slug,
        name: flavour.name,
        description: 'PLACEHOLDER description. Health claims need FSSAI/ASCI approval first.',
        type: 'coffee',
      },
      update: {},
    });

    for (const [position, pack] of PACKS.entries()) {
      const variant = await prisma.variant.upsert({
        where: { sku: `${flavour.code}-${String(pack.size).padStart(2, '0')}` },
        create: {
          productId: product.id,
          sku: `${flavour.code}-${String(pack.size).padStart(2, '0')}`,
          name: `${pack.size} sachets`,
          packSize: pack.size,
          mrpPaise: pack.mrpPaise,
          pricePaise: pack.pricePaise,
          hsnCode: COFFEE_HSN,
          gstRateBps: COFFEE_GST_BPS,
          stock: DEV_STOCK,
          weightG: pack.weightG,
          position,
        },
        update: {},
      });
      (pack.size === 6 ? sixPacks : fifteenPacks).push(variant.id);
    }
  }
  return { sixPacks, fifteenPacks };
}

async function seedTrialKitAndTumbler(): Promise<void> {
  const tumbler = await prisma.product.upsert({
    where: { slug: 'tumbler' },
    create: { slug: 'tumbler', name: 'Tumbler', type: 'merchandise' },
    update: {},
  });
  await prisma.variant.upsert({
    where: { sku: 'TUMBLER' },
    create: {
      productId: tumbler.id,
      sku: 'TUMBLER',
      name: 'Tumbler',
      mrpPaise: 59900, // PLACEHOLDER
      pricePaise: 49900, // PLACEHOLDER
      hsnCode: TUMBLER_HSN,
      gstRateBps: TUMBLER_GST_BPS,
      stock: DEV_STOCK,
      weightG: 350,
    },
    update: {},
  });

  const trialKit = await prisma.product.upsert({
    where: { slug: 'trial-kit' },
    create: {
      slug: 'trial-kit',
      name: 'Trial Kit',
      description: 'One sachet of each flavour + tumbler. One per customer.',
      type: 'trial_kit',
      onePerCustomer: true,
    },
    update: {},
  });
  await prisma.variant.upsert({
    where: { sku: 'TRIAL-KIT' },
    create: {
      productId: trialKit.id,
      sku: 'TRIAL-KIT',
      name: '5 sachets + tumbler',
      packSize: 5,
      mrpPaise: 39900, // ₹399 (CLAUDE.md §1)
      pricePaise: 39900,
      hsnCode: TUMBLER_HSN, // PLACEHOLDER: mixed supply → highest-rate component
      gstRateBps: TUMBLER_GST_BPS, // PLACEHOLDER
      stock: DEV_STOCK,
      weightG: 450,
    },
    update: {},
  });
}

async function seedBundles(sixPacks: string[], fifteenPacks: string[]): Promise<void> {
  const bundles = [
    {
      slug: 'bundle-of-2',
      sku: 'BUNDLE-2X15',
      name: 'Bundle of 2',
      description: 'Pick any two 15-sachet packs.',
      slots: 2,
      mrpPaise: 159800, // PLACEHOLDER
      pricePaise: 129900, // PLACEHOLDER
      variantIds: fifteenPacks,
    },
    {
      slug: 'bundle-of-3',
      sku: 'BUNDLE-3X06',
      name: 'Bundle of 3',
      description: 'Pick any three 6-sachet packs.',
      slots: 3,
      mrpPaise: 104700, // PLACEHOLDER
      pricePaise: 84900, // PLACEHOLDER
      variantIds: sixPacks,
    },
  ];

  for (const { variantIds, ...bundle } of bundles) {
    const created = await prisma.bundle.upsert({
      where: { slug: bundle.slug },
      create: { ...bundle, hsnCode: COFFEE_HSN, gstRateBps: COFFEE_GST_BPS },
      update: {},
    });
    await prisma.bundleItem.createMany({
      data: variantIds.map((variantId) => ({ bundleId: created.id, variantId })),
      skipDuplicates: true,
    });
  }
}

async function seedCollections(): Promise<void> {
  const coffee = await prisma.collection.upsert({
    where: { slug: 'coffee' },
    create: { slug: 'coffee', name: 'All flavours' },
    update: {},
  });
  const products = await prisma.product.findMany({
    where: { slug: { in: FLAVOURS.map((f) => f.slug) } },
  });
  await prisma.collectionItem.createMany({
    data: FLAVOURS.map((flavour, position) => ({
      collectionId: coffee.id,
      productId: products.find((p) => p.slug === flavour.slug)!.id,
      position,
    })),
    skipDuplicates: true,
  });
}

async function main(): Promise<void> {
  await seedSettings();
  const { sixPacks, fifteenPacks } = await seedCoffee();
  await seedTrialKitAndTumbler();
  await seedBundles(sixPacks, fifteenPacks);
  await seedCollections();

  const [products, variants, bundles, settings] = await Promise.all([
    prisma.product.count(),
    prisma.variant.count(),
    prisma.bundle.count(),
    prisma.setting.count(),
  ]);
  // eslint-disable-next-line no-console -- CLI script output
  console.log(
    `Seeded: ${products} products, ${variants} variants, ${bundles} bundles, ${settings} settings`,
  );
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console -- CLI script output
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
