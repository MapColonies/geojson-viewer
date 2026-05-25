import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Map from 'ol/Map';
import TileLayer from 'ol/layer/Tile';
import GeoJSON from 'ol/format/GeoJSON';
import WKT from 'ol/format/WKT';
import GeometryCollection from 'ol/geom/GeometryCollection';
import VectorSource from 'ol/source/Vector';
import WMTS from 'ol/source/WMTS';
import shp from 'shpjs';
import * as shpwrite from '@mapbox/shp-write';
import ControlsPanel from './components/ControlsPanel';
import DrawToolbar from './components/DrawToolbar';
import GeoJsonPanel from './components/GeoJsonPanel';
import MapCanvas from './components/MapCanvas';
import ZoomToolbar from './components/ZoomToolbar';
import type { TileJumpRequest } from './components/controls/TileJumpControl';
import { getPreferredCrs } from './config';
import type { AppConfig } from './config';
import type { DrawMode } from './types/map';
import { useDrawInteractions } from './hooks/useDrawInteractions';
import { useFeatureHoverHighlight } from './hooks/useFeatureHoverHighlight';
import { useGeoJsonSync } from './hooks/useGeoJsonSync';
import { useLayersUrlSync } from './hooks/useLayersUrlSync';
import { useMapUrlSync } from './hooks/useMapUrlSync';
import { useMapInstance } from './hooks/useMapInstance';
import { useTileDebugLayer } from './hooks/useTileDebugLayer';
import { useCswCatalog } from './hooks/useCswCatalog';
import { useWmtsCapabilities } from './hooks/useWmtsCapabilities';
import { useWmtsLayer } from './hooks/useWmtsLayer';
import { useWmtsLayerFromCsw } from './hooks/useWmtsLayerFromCsw';

const MAX_VIEW_ZOOM = 20;

type AppProps = {
	config: AppConfig;
};

type GeoJsonObject = {
	type?: string;
	features?: unknown;
	geometry?: unknown;
	properties?: unknown;
};

type FeatureCollection = {
	type: 'FeatureCollection';
	features: Array<Record<string, unknown>>;
};

type GeoJsonExportParseResult =
	| { collection: FeatureCollection }
	| { error: string };

const normalizeToFeatureCollection = (input: unknown) => {
	if (!input || typeof input !== 'object') return null;
	const value = input as GeoJsonObject;
	if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
		return value;
	}
	if (value.type === 'Feature') {
		return { type: 'FeatureCollection', features: [value] };
	}
	if (value.type && value.geometry === undefined && 'coordinates' in value) {
		return {
			type: 'FeatureCollection',
			features: [{ type: 'Feature', properties: {}, geometry: value }],
		};
	}
	return null;
};

const mergeFeatureCollections = (input: unknown) => {
	const collections = Array.isArray(input)
		? input.map((item) => normalizeToFeatureCollection(item)).filter(Boolean)
		: [normalizeToFeatureCollection(input)].filter(Boolean);
	if (collections.length === 0) return null;
	const features = collections.flatMap((collection) =>
		Array.isArray(collection?.features) ? collection.features : [],
	);
	if (features.length === 0) return null;
	return { type: 'FeatureCollection', features };
};

const ensureExportProperties = (collection: FeatureCollection): FeatureCollection => {
	return {
		...collection,
		features: collection.features.map((feature) => {
			if (!feature || feature.type !== 'Feature') return feature;
			return {
				...feature,
				properties:
					feature.properties === null || feature.properties === undefined
						? {}
						: feature.properties,
			};
		}),
	};
};

const parseGeoJsonForExport = (source: string): GeoJsonExportParseResult => {
	if (!source.trim()) {
		return { error: 'GeoJSON is empty.' };
	}
	try {
		const parsed = JSON.parse(source) as unknown;
		const normalized = normalizeToFeatureCollection(parsed) as
			| FeatureCollection
			| null;
		if (!normalized) {
			return {
				error: 'GeoJSON must be a FeatureCollection, Feature, or Geometry.',
			};
		}
		if (!Array.isArray(normalized.features) || normalized.features.length === 0) {
			return { error: 'GeoJSON has no features.' };
		}
		return { collection: ensureExportProperties(normalized) };
	} catch (error) {
		return { error: 'Invalid GeoJSON.' };
	}
};

const triggerDownload = (blob: Blob, filename: string) => {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = 'noopener';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
};

const getZipBlob = (data: unknown) => {
	if (data instanceof Blob) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Blob([data], { type: 'application/zip' });
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		const bytes = new Uint8Array(
			view.buffer,
			view.byteOffset,
			view.byteLength,
		);
		const copy = new Uint8Array(bytes);
		return new Blob([copy.buffer], { type: 'application/zip' });
	}
	throw new Error('Unsupported shapefile export output.');
};

const resolveWmtsTileGrid = (map: Map) => {
	const wmtsSource = map
		.getLayers()
		.getArray()
		.slice()
		.reverse()
		.map((layer) =>
			layer instanceof TileLayer ? layer.getSource() : null,
		)
		.find((source) => source instanceof WMTS) as WMTS | undefined;
	return wmtsSource?.getTileGrid() ?? null;
};

function App({ config }: AppProps) {
	const mapRef = useRef<HTMLDivElement | null>(null);
	const vectorSource = useMemo(() => new VectorSource({ wrapX: false }), []);
	const [drawType, setDrawType] = useState<DrawMode>('None');
	const [isTileDebugEnabled, setIsTileDebugEnabled] = useState(
		() => localStorage.getItem('tileDebug') === 'true',
	);
	useEffect(() => {
		localStorage.setItem('tileDebug', String(isTileDebugEnabled));
	}, [isTileDebugEnabled]);
	const [hoveredFeatureKey, setHoveredFeatureKey] = useState<string | null>(
		null,
	);
	const [uploadError, setUploadError] = useState('');
	const [exportError, setExportError] = useState('');
	const [wktInput, setWktInput] = useState('');
	const [wktError, setWktError] = useState('');
	const wktFormat = useMemo(() => new WKT(), []);
	const geoJsonFormat = useMemo(() => new GeoJSON(), []);
	const preferredCrs = useMemo(
		() => getPreferredCrs(config.mapProjection),
		[config.mapProjection],
	);
	const hasCswUrl = Boolean(config.cswUrl?.trim());
	const hasWmtsUrl = Boolean(config.wmtsCapabilitiesUrl?.trim());
	const hasConfigConflict = hasCswUrl && hasWmtsUrl;
	const hasMissingConfig = !hasCswUrl && !hasWmtsUrl;
	const useCsw = hasCswUrl && !hasConfigConflict;
	const useWmts = hasWmtsUrl && !hasConfigConflict;

	const {
		capabilities,
		layers,
		selectedLayers,
		setSelectedLayers,
		selectedLayerTitle,
		capabilitiesError,
	} = useWmtsCapabilities(
		config.wmtsCapabilitiesUrl ?? '',
		preferredCrs,
		config.wmtsApiKey,
		config.defaultWmtsLayers,
		useWmts,
	);

	const {
		layers: cswLayers,
		selectedLayers: cswSelectedLayers,
		setSelectedLayers: setCswSelectedLayers,
		selectedLayerTitle: cswSelectedLayerTitle,
		error: cswError,
		wmtsMetadataByLayerId,
	} = useCswCatalog(
		config.cswUrl ?? '',
		config.wmtsApiKey,
		config.defaultWmtsLayers,
		useCsw,
	);

	const { mapRef: mapInstanceRef, modify } = useMapInstance({
		mapRef,
		vectorSource,
		projection: config.mapProjection,
		maxZoom: MAX_VIEW_ZOOM,
	});

	const { markUserMoved } = useMapUrlSync(mapInstanceRef);

	const activeLayers = useCsw ? cswLayers : layers;
	const activeSelectedLayers = useCsw ? cswSelectedLayers : selectedLayers;
	const setActiveSelectedLayers = useCsw
		? setCswSelectedLayers
		: setSelectedLayers;
	const activeSelectedLayerTitle = useCsw
		? cswSelectedLayerTitle
		: selectedLayerTitle;

	useLayersUrlSync({
		layers: activeLayers,
		selectedLayers: activeSelectedLayers,
		setSelectedLayers: setActiveSelectedLayers,
	});

	useWmtsLayer({
		mapRef: mapInstanceRef,
		capabilities: useWmts ? capabilities : null,
		selectedLayers: useWmts ? activeSelectedLayers : [],
		apiKey: config.wmtsApiKey,
	});

	const { error: cswLayerError } = useWmtsLayerFromCsw({
		mapRef: mapInstanceRef,
		selectedLayers: useCsw ? activeSelectedLayers : [],
		wmtsMetadataByLayerId,
		apiKey: config.wmtsApiKey,
		enabled: useCsw,
	});

	const activeCapabilitiesError = hasConfigConflict
		? 'Configure either cswUrl or wmtsCapabilitiesUrl, not both.'
		: hasMissingConfig
			? 'Configure either cswUrl or wmtsCapabilitiesUrl to load layers.'
			: useCsw
				? cswError || cswLayerError
				: capabilitiesError;

	useTileDebugLayer({
		mapRef: mapInstanceRef,
		enabled: isTileDebugEnabled,
		projection: config.mapProjection,
		selectedLayerIds: activeSelectedLayers,
	});

	const handleDrawEnd = useCallback(() => {
		setDrawType('None');
	}, []);

	useDrawInteractions({
		mapRef: mapInstanceRef,
		vectorSource,
		drawMode: drawType,
		onDrawEnd: handleDrawEnd,
	});

	const { geoJson, geoJsonError, handleEditorChange } = useGeoJsonSync({
		vectorSource,
		mapRef: mapInstanceRef,
		modify,
		projection: config.mapProjection,
	});

	useEffect(() => {
		if (exportError) {
			setExportError('');
		}
	}, [geoJson, exportError]);

	useEffect(() => {
		if (wktError) {
			setWktError('');
		}
	}, [geoJson]);

	const getWktFromGeoJson = useCallback(
		(source: string) => {
			const parsed = parseGeoJsonForExport(source);
			if ('error' in parsed) return '';
			const features = geoJsonFormat.readFeatures(parsed.collection, {
				dataProjection: 'EPSG:4326',
				featureProjection: 'EPSG:4326',
			});
			const geometries = features
				.map((feature) => feature.getGeometry())
				.filter((geometry): geometry is NonNullable<typeof geometry> =>
					Boolean(geometry),
				);
			if (geometries.length === 0) return '';
			const geometry =
				geometries.length === 1
					? geometries[0]
					: new GeometryCollection(geometries);
			return wktFormat.writeGeometry(geometry, {
				dataProjection: 'EPSG:4326',
				featureProjection: 'EPSG:4326',
			});
		},
		[geoJsonFormat, wktFormat],
	);

	const handleEditorChangeWithClear = useCallback(
		(value?: string, options?: { fit?: boolean }) => {
			if (uploadError) {
				setUploadError('');
			}
			if (exportError) {
				setExportError('');
			}
			handleEditorChange(value, options);
		},
		[handleEditorChange, exportError, uploadError],
	);

	const handleWktChange = useCallback(
		(value: string) => {
			setWktInput(value);
			if (!value.trim()) {
				setWktError('');
				return;
			}
			try {
				const feature = wktFormat.readFeature(value, {
					dataProjection: 'EPSG:4326',
					featureProjection: 'EPSG:4326',
				});
				const featureObject = geoJsonFormat.writeFeatureObject(feature, {
					dataProjection: 'EPSG:4326',
					featureProjection: 'EPSG:4326',
				});
				if (!featureObject || featureObject.type !== 'Feature') {
					setWktError('WKT did not produce a feature.');
					return;
				}
				const normalized: FeatureCollection = {
					type: 'FeatureCollection',
					features: [
						{
							...featureObject,
							properties:
								featureObject.properties === null ||
								featureObject.properties === undefined
									? {}
									: featureObject.properties,
						},
					],
				};
				const json = JSON.stringify(normalized, null, 2);
				setWktError('');
				handleEditorChangeWithClear(json, { fit: true });
			} catch (error) {
				const rawMessage =
					error instanceof Error ? error.message : 'Unknown error';
				const trimmedMessage = rawMessage.split(' in ')[0].trim();
				setWktError(`Failed to load WKT: ${trimmedMessage}`);
			}
		},
		[
			geoJsonFormat,
			handleEditorChangeWithClear,
			wktError,
			wktFormat,
		],
	);

	useFeatureHoverHighlight({
		mapRef: mapInstanceRef,
		vectorSource,
		hoveredKey: hoveredFeatureKey,
	});

	const handleGeoJsonUpload = useCallback(
		async (file: File | null) => {
			if (!file) return;
			try {
				setUploadError('');
				const isZip =
					file.name.toLowerCase().endsWith('.zip') ||
					file.type === 'application/zip' ||
					file.type === 'application/x-zip-compressed';
				if (isZip) {
					const buffer = await file.arrayBuffer();
					const parsed = await shp(buffer);
					const normalized = mergeFeatureCollections(parsed);
					if (!normalized) {
						setUploadError('No features found in shapefile.');
						return;
					}
					const json = JSON.stringify(normalized, null, 2);
					handleEditorChangeWithClear(json, { fit: true });
					return;
				}
				const content = await file.text();
				handleEditorChangeWithClear(content, { fit: true });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unknown error';
				setUploadError(`Failed to read file: ${message}`);
			}
		},
		[handleEditorChangeWithClear],
	);

	const handleGeoJsonPaste = useCallback(
		(value: string) => {
			handleEditorChangeWithClear(value, { fit: true });
		},
		[handleEditorChangeWithClear],
	);

	const handleGeoJsonExport = useCallback(() => {
		const parsed = parseGeoJsonForExport(geoJson);
		if ('error' in parsed) {
			setExportError(parsed.error);
			return;
		}
		const blob = new Blob([geoJson], { type: 'application/geo+json' });
		triggerDownload(blob, 'geojson-export.geojson');
		if (exportError) {
			setExportError('');
		}
	}, [exportError, geoJson]);

	useEffect(() => {
		const wkt = getWktFromGeoJson(geoJson);
		setWktInput(wkt);
	}, [geoJson, getWktFromGeoJson]);

	const handleShapefileExport = useCallback(async () => {
		const parsed = parseGeoJsonForExport(geoJson);
		if ('error' in parsed) {
			setExportError(parsed.error);
			return;
		}
		try {
			const zipData = await shpwrite.zip(parsed.collection, {
				compression: 'STORE',
				outputType: 'blob',
			});
			const blob = getZipBlob(zipData);
			triggerDownload(blob, 'shapefile-export.zip');
			if (exportError) {
				setExportError('');
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown error';
			setExportError(`Failed to export shapefile: ${message}`);
		}
	}, [exportError, geoJson]);

	const handleZoom = (delta: number) => {
		const map = mapInstanceRef.current;
		if (!map) return;
		markUserMoved();
		const view = map.getView();
		const currentZoom = view.getZoom() ?? 0;
		const minZoom = view.getMinZoom() ?? 0;
		const maxZoom = view.getMaxZoom() ?? MAX_VIEW_ZOOM;
		const nextZoom = Math.min(
			maxZoom,
			Math.max(minZoom, currentZoom + delta),
		);
		view.animate({ zoom: nextZoom, duration: 200 });
	};

	const handleTileJump = useCallback(
		(request: TileJumpRequest) => {
			const map = mapInstanceRef.current;
			if (!map) return 'Map is not ready yet.';
			const tileGrid = resolveWmtsTileGrid(map);
			if (!tileGrid) return 'No WMTS layer is active.';
			const minZoom = tileGrid.getMinZoom();
			const maxZoom = tileGrid.getMaxZoom();
			if (request.z < minZoom || request.z > maxZoom) {
				return `Zoom must be between ${minZoom} and ${maxZoom}.`;
			}
			if (request.x < 0 || request.y < 0) {
				return 'Tile coordinates must be non-negative.';
			}
			const fullRange = tileGrid.getFullTileRange(request.z);
			const fallbackMax = Math.pow(2, request.z) - 1;
			const minX = fullRange?.minX ?? 0;
			const maxX = fullRange?.maxX ?? fallbackMax;
			const minY = fullRange?.minY ?? 0;
			const maxY = fullRange?.maxY ?? fallbackMax;
			const normalizedY =
				request.mode === 'tms' ? maxY - request.y : request.y;
			if (
				normalizedY < minY ||
				normalizedY > maxY ||
				request.x < minX ||
				request.x > maxX
			) {
				return `Tile is outside range x:${minX}-${maxX}, y:${minY}-${maxY} at z ${request.z}.`;
			}
			const center = tileGrid.getTileCoordCenter([
				request.z,
				request.x,
				normalizedY,
			]);
			const resolution = tileGrid.getResolution(request.z);
			markUserMoved();
			const view = map.getView();
			view.animate({ center, resolution, duration: 250 });
			return null;
		},
		[mapInstanceRef, markUserMoved],
	);

	return (
		<div className='app'>
			<MapCanvas className='map' ref={mapRef} />
			<div className='dev-notice'>
				Development tool only. Not part of MapColonies production systems.
			</div>
			<ControlsPanel
				capabilitiesError={activeCapabilitiesError}
				selectedLayerTitle={activeSelectedLayerTitle}
				layers={activeLayers}
				selectedLayers={activeSelectedLayers}
				onLayerChange={setActiveSelectedLayers}
				onGeoJsonUpload={handleGeoJsonUpload}
				onGeoJsonExport={handleGeoJsonExport}
				onShapefileExport={handleShapefileExport}
				onWktChange={handleWktChange}
				wktValue={wktInput}
				wktError={wktError}
				geoJsonExportDisabled={!geoJson.trim() || !!geoJsonError}
				geoJsonExportError={exportError}
				isTileDebugEnabled={isTileDebugEnabled}
				onToggleTileDebug={() =>
					setIsTileDebugEnabled((enabled) => !enabled)
				}
				onTileJump={handleTileJump}
			/>
			<ZoomToolbar
				onZoomIn={() => handleZoom(1)}
				onZoomOut={() => handleZoom(-1)}
			/>
			<DrawToolbar drawMode={drawType} onChange={setDrawType} />
			<GeoJsonPanel
				value={geoJson}
				onChange={handleEditorChangeWithClear}
				onPaste={handleGeoJsonPaste}
				onHoverFeatureKey={setHoveredFeatureKey}
				error={uploadError || geoJsonError}
			/>
		</div>
	);
}

export default App;
