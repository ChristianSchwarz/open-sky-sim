using System;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>JsText.ToFixed's double fast path against the exact BigInteger path.</summary>
public class JsTextToFixedTests
{
    [Fact]
    public void FastPathMatchesExactPath()
    {
        var rng = new Random(1234);
        for (int i = 0; i < 400000; i++)
        {
            int digits = rng.Next(0, 6);
            double mag = Math.Pow(10, rng.Next(-4, 12));
            double x = (rng.NextDouble() - 0.5) * 2 * mag;
            // Every fourth value lands on (or one ulp off) a decimal tie.
            if (i % 4 == 0)
            {
                double p = Math.Pow(10, digits);
                x = (Math.Round(x * p) + 0.5) / p;
                if (i % 8 == 0) x = BitConverter.Int64BitsToDouble(BitConverter.DoubleToInt64Bits(x) + (rng.Next(0, 2) == 0 ? 1 : -1));
            }
            Assert.Equal(JsText.ToFixedExact(x, digits), JsText.ToFixed(x, digits));
        }
    }

    [Theory]
    [InlineData(154.5, 0, "155")]
    [InlineData(0.5, 0, "1")]
    [InlineData(1.25, 1, "1.3")]
    [InlineData(-0.0001, 2, "-0.00")]
    [InlineData(1.005, 2, "1.00")]
    public void KnownValues(double x, int digits, string expected) => Assert.Equal(expected, JsText.ToFixed(x, digits));
}
