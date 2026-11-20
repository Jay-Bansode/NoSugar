import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
  type BundleDetail,
  type BundleSummary,
  type Collection,
  type Paginated,
  type ProductDetail,
  type ProductListQuery,
  productListQuerySchema,
  type ProductSummary,
  slugSchema,
} from '@brand/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public } from '../auth/auth.guard.js';
import { CatalogService } from './catalog.service.js';

/** Short browser/CDN caching: catalog edits show up within a minute. */
const CACHE = 'public, max-age=60, stale-while-revalidate=300';
const slugPipe = new ZodValidationPipe(slugSchema);

@Public()
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @Header('Cache-Control', CACHE)
  listProducts(
    @Query(new ZodValidationPipe(productListQuerySchema)) query: ProductListQuery,
  ): Promise<Paginated<ProductSummary>> {
    return this.catalog.listProducts(query);
  }

  @Get('products/:slug')
  @Header('Cache-Control', CACHE)
  getProduct(@Param('slug', slugPipe) slug: string): Promise<ProductDetail> {
    return this.catalog.getProduct(slug);
  }

  @Get('collections/:slug')
  @Header('Cache-Control', CACHE)
  getCollection(@Param('slug', slugPipe) slug: string): Promise<Collection> {
    return this.catalog.getCollection(slug);
  }

  @Get('bundles')
  @Header('Cache-Control', CACHE)
  listBundles(): Promise<BundleSummary[]> {
    return this.catalog.listBundles();
  }

  @Get('bundles/:slug')
  @Header('Cache-Control', CACHE)
  getBundle(@Param('slug', slugPipe) slug: string): Promise<BundleDetail> {
    return this.catalog.getBundle(slug);
  }
}
