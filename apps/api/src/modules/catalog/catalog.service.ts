import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type BundleDetail,
  type BundleSummary,
  type Collection,
  ErrorCode,
  type Paginated,
  type ProductDetail,
  type ProductListQuery,
  type ProductSummary,
} from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogMapper } from './catalog.mapper.js';

/** Until the CDN exists, media paths are relative to the site. */
const DEFAULT_MEDIA_BASE = '/media';

const activeVariants = {
  where: { isActive: true },
  orderBy: [{ position: 'asc' }, { id: 'asc' }],
} satisfies Prisma.Product$variantsArgs;

const orderedMedia = {
  orderBy: [{ position: 'asc' }, { id: 'asc' }],
} satisfies Prisma.Product$mediaArgs;

/** A product is listed only if it and at least one of its variants are active. */
const listable = {
  isActive: true,
  variants: { some: { isActive: true } },
} satisfies Prisma.ProductWhereInput;

@Injectable()
export class CatalogService {
  private readonly mapper: CatalogMapper;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.mapper = new CatalogMapper(env.CDN_BASE_URL ?? DEFAULT_MEDIA_BASE);
  }

  async listProducts(query: ProductListQuery): Promise<Paginated<ProductSummary>> {
    const rows = await this.prisma.product.findMany({
      where: { ...listable, ...(query.type ? { type: query.type } : {}) },
      include: { variants: activeVariants, media: { ...orderedMedia, take: 1 } },
      // UUIDv7 ids are time-ordered, so this is creation order and a stable cursor.
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((row) => this.mapper.productSummary(row)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getProduct(slug: string): Promise<ProductDetail> {
    const row = await this.prisma.product.findFirst({
      where: { slug, ...listable },
      include: { variants: activeVariants, media: orderedMedia },
    });
    if (!row) throw notFound('Product');
    return this.mapper.productDetail(row);
  }

  async getCollection(slug: string): Promise<Collection> {
    const row = await this.prisma.collection.findFirst({
      where: { slug, isActive: true },
      include: {
        items: {
          where: { product: listable },
          orderBy: [{ position: 'asc' }, { productId: 'asc' }],
          include: {
            product: { include: { variants: activeVariants, media: { ...orderedMedia, take: 1 } } },
          },
        },
      },
    });
    if (!row) throw notFound('Collection');
    return {
      slug: row.slug,
      name: row.name,
      description: row.description,
      products: row.items.map((item) => this.mapper.productSummary(item.product)),
    };
  }

  async listBundles(): Promise<BundleSummary[]> {
    const rows = await this.prisma.bundle.findMany({
      where: { isActive: true },
      orderBy: [{ slots: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.mapper.bundleSummary(row));
  }

  async getBundle(slug: string): Promise<BundleDetail> {
    const row = await this.prisma.bundle.findFirst({
      where: { slug, isActive: true },
      include: {
        items: {
          where: { variant: { isActive: true, product: { isActive: true } } },
          include: {
            variant: {
              include: {
                product: {
                  select: { slug: true, name: true, media: { ...orderedMedia, take: 1 } },
                },
              },
            },
          },
        },
      },
    });
    if (!row || row.items.length === 0) throw notFound('Bundle');
    const options = [...row.items].sort((a, b) =>
      a.variant.product.name.localeCompare(b.variant.product.name, 'en-IN'),
    );
    return this.mapper.bundleDetail(row, options);
  }
}

function notFound(what: string): AppException {
  return new AppException(ErrorCode.NOT_FOUND, `${what} not found`, HttpStatus.NOT_FOUND);
}
