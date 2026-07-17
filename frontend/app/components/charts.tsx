"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const AXIS = "#7c8896";
const GRID = "#1e2731";

const tooltipStyle = {
  backgroundColor: "#121820",
  border: "1px solid #1e2731",
  borderRadius: 6,
  fontSize: 12,
};

export interface SeriesDef {
  key: string;
  name: string;
  color: string;
  type?: "line" | "bar" | "area";
  yAxis?: "left" | "right";
  dashed?: boolean;
}

export function MultiSeriesChart({
  data,
  series,
  xKey = "sp",
  height = 260,
  rightLabel,
  leftLabel,
  zeroLine = false,
}: {
  data: Record<string, number | string | null>[];
  series: SeriesDef[];
  xKey?: string;
  height?: number;
  rightLabel?: string;
  leftLabel?: string;
  zeroLine?: boolean;
}) {
  const hasRight = series.some((s) => s.yAxis === "right");
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
        <XAxis dataKey={xKey} stroke={AXIS} tick={{ fontSize: 11 }} minTickGap={18} />
        <YAxis
          yAxisId="left"
          stroke={AXIS}
          tick={{ fontSize: 11 }}
          width={48}
          label={leftLabel ? { value: leftLabel, angle: -90, position: "insideLeft", fill: AXIS, fontSize: 10 } : undefined}
        />
        {hasRight && (
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke={AXIS}
            tick={{ fontSize: 11 }}
            width={48}
            label={rightLabel ? { value: rightLabel, angle: 90, position: "insideRight", fill: AXIS, fontSize: 10 } : undefined}
          />
        )}
        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#d7dee6" }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {zeroLine && <ReferenceLine y={0} yAxisId="left" stroke={AXIS} strokeDasharray="3 3" />}
        {series.map((s) => {
          const yAxisId = s.yAxis || "left";
          if (s.type === "bar")
            return <Bar key={s.key} yAxisId={yAxisId} dataKey={s.key} name={s.name} fill={s.color} />;
          if (s.type === "area")
            return (
              <Area
                key={s.key}
                yAxisId={yAxisId}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                fill={`${s.color}33`}
              />
            );
          return (
            <Line
              key={s.key}
              yAxisId={yAxisId}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={1.6}
              strokeDasharray={s.dashed ? "4 3" : undefined}
              dot={false}
            />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
