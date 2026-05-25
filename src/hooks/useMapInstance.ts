import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import VectorLayer from 'ol/layer/Vector';
import Modify from 'ol/interaction/Modify';
import type VectorSource from 'ol/source/Vector';

type UseMapInstanceParams = {
	mapRef: React.RefObject<HTMLDivElement>;
	vectorSource: VectorSource;
	projection: string;
	maxZoom: number;
};

export function useMapInstance({
	mapRef,
	vectorSource,
	projection,
	maxZoom,
}: UseMapInstanceParams) {
	const mapInstanceRef = useRef<Map | null>(null);
	const [modify, setModify] = useState<Modify | null>(null);

	useEffect(() => {
		if (!mapRef.current || mapInstanceRef.current) return;
		const vectorLayer = new VectorLayer({
			source: vectorSource,
		});
		const map = new Map({
			target: mapRef.current,
			layers: [vectorLayer],
			view: new View({
				projection,
				center: [0, 0],
				zoom: 2,
				minZoom: 0,
				maxZoom,
				constrainResolution: false,
			}),
			controls: [],
		});
		const modify = new Modify({ source: vectorSource });
		map.addInteraction(modify);
		setModify(modify);
		mapInstanceRef.current = map;
		return () => {
			map.setTarget(undefined);
			mapInstanceRef.current = null;
			setModify(null);
		};
	}, [mapRef, maxZoom, projection, vectorSource]);

	return { mapRef: mapInstanceRef, modify };
}
