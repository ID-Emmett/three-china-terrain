# Data Attribution

- Administrative boundaries: Alibaba Cloud DataV GeoAtlas public dataset, used for prototype development. Production publication requires an independent licensing and map-compliance review.
- Elevation: Mapzen/AWS Terrain Tiles (Terrarium format), assembled from public elevation sources including SRTM and other global elevation datasets.
- Land topology: Alibaba Cloud DataV China province polygons and Natural Earth 1:50m surrounding land polygons. China administrative coastlines take precedence within the China coastal authority band; Natural Earth supplies surrounding geographic context. Natural Earth data is public domain.

The generated application does not call these services at runtime. Sources are downloaded and converted into local assets by the data pipeline.
