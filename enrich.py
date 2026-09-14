"""Fuse independently sourced footprints and satellite canopy estimates with LiDAR."""
import json
import numpy as np
from buildings import fetch_footprints
from canopy import fetch_canopy


def fuse_layers(ground,buildings,trees,unknown,labels,canopy,tag_heights=None,fallback_height=None):
    buildings=buildings.copy();trees=trees.copy();unknown=unknown.copy()
    uncertain=np.zeros(ground.shape,dtype=bool)
    # A footprint identifies a structure, while point returns measure its top.
    # Conservatively use the highest in-footprint return across its footprint.
    surface=np.fmax(buildings,unknown)
    elevated=(labels>0)&np.isfinite(surface)&np.isfinite(ground)&(surface>ground+1)
    tops=np.full(int(labels.max())+1,-np.inf,dtype=np.float32)
    np.maximum.at(tops,labels[elevated],surface[elevated])
    heights=tops[labels]
    found=(labels>0)&np.isfinite(heights)
    buildings[found]=np.fmax(buildings[found],heights[found])
    unknown[found&(unknown<=heights)]=np.nan

    unmeasured=(labels>0)&~np.isfinite(heights)
    if fallback_height is not None or (tag_heights is not None and np.any(tag_heights>0)):
        assigned_h=np.zeros(ground.shape,dtype=np.float32)
        if tag_heights is not None:
            has_tag=unmeasured&(tag_heights>0)
            assigned_h[has_tag]=tag_heights[has_tag]
        if fallback_height is not None:
            needs_fallback=unmeasured&(assigned_h==0)
            assigned_h[needs_fallback]=float(fallback_height)
        apply_h=unmeasured&(assigned_h>0)&np.isfinite(ground)
        buildings[apply_h]=np.fmax(buildings[apply_h],ground[apply_h]+assigned_h[apply_h])
        uncertain[unmeasured&~apply_h]=True
    else:
        uncertain[unmeasured]=True

    # Satellite canopy predictions identify vegetation; retain measured canopy
    # where classified. Do not overwrite known or footprint-identified buildings.
    canopy_mask=(labels==0)&~np.isfinite(buildings)&np.isfinite(ground)&np.isfinite(canopy)&(canopy>=2)
    trees[canopy_mask]=np.fmax(trees[canopy_mask],ground[canopy_mask]+canopy[canopy_mask])
    # Satellite canopy supplies the object label; retain a taller measured
    # surface return as the canopy top. This is an explicitly inferred class.
    assign=canopy_mask&np.isfinite(unknown)
    trees[assign]=np.fmax(trees[assign],unknown[assign])
    unknown[assign]=np.nan
    canopy_uncertain=np.isfinite(ground)&~np.isfinite(canopy)&~np.isfinite(trees)&~np.isfinite(buildings)
    return buildings,trees,unknown,uncertain,canopy_uncertain


def enrich_scene(path,progress=None):
    with np.load(path,allow_pickle=False) as data:
        arrays={k:data[k].copy() for k in data.files if k!='meta'}
        meta=json.loads(str(data['meta']))
    shape=arrays['ground'].shape;notes=[];sources={}
    tag_heights=None
    try:
        fp_res=fetch_footprints(meta,shape,progress)
        if len(fp_res)==3:
            labels,tag_heights,sources['buildings']=fp_res
        else:
            labels,sources['buildings']=fp_res
    except Exception as exc:
        labels=np.zeros(shape,dtype=np.int32);notes.append('Building footprint fetch unavailable: '+str(exc))
    try: canopy,sources['canopy']=fetch_canopy(meta,shape,progress)
    except Exception as exc:
        canopy=np.full(shape,np.nan);notes.append('Satellite canopy fetch unavailable: '+str(exc))
    # Removed default 7.5m estimation: buildings without measured LiDAR or OSM tag
    # height now stay unknown (honest) instead of invented 7.5m. Only explicit
    # OSM height tags are used.
    fallback_h = None
    arrays['buildings'],arrays['trees'],arrays['unknown'],arrays['uncertain'],arrays['canopy_uncertain']=fuse_layers(
        arrays['ground'],arrays['buildings'],arrays['trees'],arrays['unknown'],labels,canopy,
        tag_heights=tag_heights,fallback_height=fallback_h
    )
    if 'structural_unknown' in arrays:
        # Keep structural unknowns (wires, bridges, towers) separate: only promote
        # to unknown where no building/tree already exists and not just thin wires.
        # Previously this blindly maxed unknown, causing spurious "blocked by unknown"
        # on every powerline. Now keep it as uncertain hint, not hard block.
        struct = arrays['structural_unknown']
        has_hard = np.isfinite(arrays['buildings']) | np.isfinite(arrays['trees'])
        promote = np.isfinite(struct) & ~has_hard & np.isfinite(arrays['ground']) & (struct > arrays['ground'] + 2.0)
        # Only use structural where it is at least 2m above ground and not already a building/tree
        arrays['unknown'][promote] = np.fmax(arrays['unknown'][promote], struct[promote])
        # Thin/near-ground structural stays in uncertain, not hard unknown
        thin_struct = np.isfinite(struct) & ~promote & ~has_hard
        arrays['uncertain'][thin_struct] = True
    meta['analysis_notes']=[n for n in meta.get('analysis_notes',[]) if 'class-6' not in n and 'class 3/4/5' not in n and 'Withheld' not in n]
    meta['enrichment_sources']=sources
    meta.setdefault('analysis_notes',[]).extend(notes)
    if 'buildings' in sources:
        if meta.get('is_dem'):
            meta['analysis_notes'].append('OSM footprint building heights use explicit OSM height tags only; buildings without a measured LiDAR return or tag remain unknown (no default height is invented).')
        else:
            meta['analysis_notes'].append('OSM footprint building heights use the maximum elevated LiDAR return inside each footprint, potentially including roof trees/equipment. Mapped buildings without a usable height remain unknown. Building mapping and survey dates differ.')
    if 'canopy' in sources:
        meta['analysis_notes'].append('Tree layer includes automatically fetched Meta/WRI satellite-derived canopy estimates (>=2 m), alongside classified LiDAR canopy. Predictions can miss or overestimate trees. Unclassified LiDAR returns within satellite tree areas are inferred to be vegetation; their heights can raise the canopy estimate. Object labels and cross-date matching can be wrong.')
    meta['name']='Automatically fetched terrain, buildings & canopy'
    meta['source']+='; '+ '; '.join(str(v.get('source',k)) for k,v in sources.items())
    meta['enrichment_counts']={k:int(np.isfinite(arrays[k]).sum()) for k in ('ground','buildings','trees','unknown')}
    meta['enrichment_counts']['uncertain']=int(arrays['uncertain'].sum())
    np.savez_compressed(path,**arrays,meta=json.dumps(meta))
    return meta
